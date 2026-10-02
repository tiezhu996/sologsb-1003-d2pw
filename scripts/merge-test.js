/* eslint-disable no-console */
/**
 * 断网草稿 × 上游更新 三方合并引擎的纯函数测试。
 * 由 `npm run test:merge` 用 tsc 编译到临时目录后以 Node 运行，不依赖 React / 浏览器。
 * 覆盖需求：原文未动保留译文/讨论/确认；原文变译文未改接回+待处理；两边都改并列保留；
 * 新增留空；移除入清单；稳定标识/代码块/占位符边界挂接；重复句顺序；检查点重试幂等；旧稿无基线。
 */
const assert = require('node:assert/strict')
const { mergeIntoState, computeStableKey, toUpstreamBlocks, restoreRemoved } = require(process.env.MERGE_TEST_OUT + '/merge.js')
const { parseMarkdown } = require(process.env.MERGE_TEST_OUT + '/markdown.js')
const { seedSegments, seedDiscussions, seedUpstreamMarkdown } = require(process.env.MERGE_TEST_OUT + '/seed.js')

const kindOf = (text, code) => (code ? 'code'
  : /^#{1,6}\s+/.test(text) ? 'heading'
    : /\[[^\]]+\]\(/.test(text) ? 'link'
      : /\{\{|\{[A-Za-z_]|%[sd]/.test(text) ? 'variable'
        : 'paragraph')
const up = (text, code = false) => {
  const kind = kindOf(text, code)
  return { index: 0, kind, sourceText: text, protectedTokens: [], stableKey: computeStableKey(text, kind) }
}
const seg = (id, sourceText, overrides = {}) => ({
  id, index: 0, kind: kindOf(sourceText, false), sourceText, targetText: '',
  status: 'draft', protectedTokens: [], note: '', ...overrides,
})
const baseState = (segments, extra = {}) => ({ segments, discussions: [], removedSegments: [], conflicts: [], history: [], ...extra })
const META = { runId: 'run-1', sourceFileName: 'deployment.md', mergedAt: 1000 }

let tests = 0
const test = (name, fn) => { fn(); tests += 1; console.log('  ✓', name) }

test('unchanged segment keeps translation, discussions and confirmed status', () => {
  const s = seg('s1', '# Hello', { targetText: '# 你好', status: 'confirmed', baseSourceText: '# Hello', baseTargetText: '# 你好', note: 'n' })
  const state = baseState([s], { discussions: [{ id: 'd1', segmentId: 's1', author: 'a', body: 'b', resolved: false, createdAt: 1 }] })
  const r = mergeIntoState(state, [up('# Hello')], META)
  assert.equal(r.summary.unchanged, 1)
  assert.equal(r.segments[0].targetText, '# 你好')
  assert.equal(r.segments[0].status, 'confirmed')
  assert.equal(r.segments[0].note, 'n')
  assert.equal(r.discussions.length, 1)
})

test('source changed, target untouched -> reattach and return to needs-work', () => {
  const s = seg('s2', 'Old source.', { targetText: '旧译文。', status: 'confirmed', baseSourceText: 'Old source.', baseTargetText: '旧译文。' })
  const r = mergeIntoState(baseState([s]), [up('New source text.')], META)
  assert.equal(r.summary.reattached, 1)
  assert.equal(r.segments[0].sourceText, 'New source text.')
  assert.equal(r.segments[0].targetText, '旧译文。')
  assert.equal(r.segments[0].status, 'needs-work')
  assert.equal(r.segments[0].previousSourceText, 'Old source.')
})

test('both sides changed -> side-by-side conflict, nothing overwritten', () => {
  const oldSource = 'Restart the pod after you update the network policy.'
  const newSource = 'Restart the controller pod after you update the network policy rules.'
  const s = seg('s3', oldSource, { targetText: '本地改过的译文', baseSourceText: oldSource, baseTargetText: '原译文' })
  const r = mergeIntoState(baseState([s]), [up(newSource)], META)
  assert.equal(r.summary.conflict, 1)
  assert.equal(r.segments[0].targetText, '本地改过的译文')
  assert.equal(r.segments[0].sourceText, oldSource)
  assert.equal(r.conflicts[0].kind, 'merge')
  assert.equal(r.conflicts[0].localText, '本地改过的译文')
  assert.equal(r.conflicts[0].upstreamSource, newSource)
})

test('added upstream segment -> empty draft', () => {
  const r = mergeIntoState(baseState([]), [up('Brand new paragraph.')], META)
  assert.equal(r.summary.added, 1)
  assert.equal(r.segments[0].targetText, '')
})

test('removed upstream segment -> removed list with translation and discussions', () => {
  const s = seg('s5', 'Gone soon.', { targetText: '将被移除', status: 'confirmed', baseSourceText: 'Gone soon.', baseTargetText: '将被移除' })
  const state = baseState([s], { discussions: [{ id: 'd5', segmentId: 's5', author: 'a', body: 'b', resolved: false, createdAt: 1 }] })
  const r = mergeIntoState(state, [], META)
  assert.equal(r.summary.removed, 1)
  assert.equal(r.removedSegments[0].targetText, '将被移除')
  assert.equal(r.removedSegments[0].discussions.length, 1)
  assert.equal(r.discussions.length, 0)
})

test('insertion in middle reattaches by stable key', () => {
  const segs = [
    seg('a', '# Title', { baseSourceText: '# Title', baseTargetText: '# 标题', targetText: '# 标题' }),
    seg('b', 'Body one.', { baseSourceText: 'Body one.', baseTargetText: '正文一。', targetText: '正文一。' }),
    seg('c', 'Body two.', { baseSourceText: 'Body two.', baseTargetText: '正文二。', targetText: '正文二。' }),
  ]
  const r = mergeIntoState(baseState(segs), [up('# Title'), up('Inserted.'), up('Body one.'), up('Body two.')], META)
  assert.equal(r.summary.unchanged, 3)
  assert.equal(r.summary.added, 1)
  assert.deepEqual(r.segments.map((s) => s.id), ['a', r.segments[1].id, 'b', 'c'])
  assert.equal(r.segments[1].targetText, '')
})

test('duplicate sentences are matched in order and keep distinct ids', () => {
  const dup = 'Repeat me.'
  const key = computeStableKey(dup, 'paragraph')
  const segs = [
    seg('d1', dup, { stableKey: key, baseSourceText: dup, baseTargetText: '重复。', targetText: '重复。' }),
    seg('d2', dup, { stableKey: key, baseSourceText: dup, baseTargetText: '', targetText: '' }),
  ]
  const r = mergeIntoState(baseState(segs), [up(dup), up(dup)], META)
  assert.deepEqual(r.segments.map((s) => s.id), ['d1', 'd2'])
})

test('duplicates with insertion between map to distinct ids', () => {
  const dup = 'Same line.'
  const key = computeStableKey(dup, 'paragraph')
  const segs = [
    seg('x1', dup, { stableKey: key, baseSourceText: dup, baseTargetText: '同一句。', targetText: '同一句。' }),
    seg('x2', dup, { stableKey: key, baseSourceText: dup, baseTargetText: '同一句。', targetText: '同一句。' }),
  ]
  const r = mergeIntoState(baseState(segs), [up(dup), up('Middle.'), up(dup)], META)
  assert.equal(r.summary.unchanged, 2)
  assert.equal(r.summary.added, 1)
  assert.deepEqual(r.segments.map((s) => s.id), ['x1', r.segments[1].id, 'x2'])
})

test('code block unchanged locally syncs upstream code automatically', () => {
  const oldCode = '```\nold\n```'
  const s = seg('c1', oldCode, { kind: 'code', targetText: oldCode, baseSourceText: oldCode, baseTargetText: oldCode })
  const r = mergeIntoState(baseState([s]), [up('```\nnew\n```', true)], META)
  assert.equal(r.summary.reattached, 1)
  assert.equal(r.segments[0].targetText, '```\nnew\n```')
})

test('code block edited locally and upstream -> conflict', () => {
  const oldCode = '```\na\n```'
  const s = seg('c2', oldCode, { kind: 'code', targetText: '```\nlocal-edit\n```', baseSourceText: oldCode, baseTargetText: oldCode })
  const r = mergeIntoState(baseState([s]), [up('```\nb\n```', true)], META)
  assert.equal(r.summary.conflict, 1)
})

test('placeholder segments keyed as variable kind and attach across parser kind drift', () => {
  const text = 'Set {replica_count} now.'
  const s = seg('v1', text, { kind: 'paragraph', targetText: '设置 {replica_count}。', baseSourceText: text, baseTargetText: '设置 {replica_count}。' })
  // 上游解析器把含占位符的同一段标成 variable：内容签名仍能挂接。
  const r = mergeIntoState(baseState([s]), [up(text)], META)
  assert.equal(r.segments[0].kind, 'variable')
  assert.equal(r.summary.unchanged, 1)
  assert.equal(r.segments[0].targetText, '设置 {replica_count}。')
})

test('legacy draft without baseline still imports and reattaches', () => {
  const s = seg('lg', 'Legacy old content.', { targetText: '旧稿译文。', status: 'confirmed' })
  const r = mergeIntoState(baseState([s]), [up('Legacy new content.')], META)
  assert.equal(r.summary.reattached, 1)
  assert.equal(r.segments[0].targetText, '旧稿译文。')
  assert.equal(r.segments[0].status, 'needs-work')
})

test('legacy draft unchanged content keeps segment', () => {
  const s = seg('lg2', 'Same old.', { targetText: '译文', status: 'confirmed' })
  const r = mergeIntoState(baseState([s]), [up('Same old.')], META)
  assert.equal(r.summary.unchanged, 1)
})

test('checkpoint retry with same runId is idempotent: no duplicate history or segments', () => {
  const s = seg('r1', 'Old source sentence.', { targetText: '译文', baseSourceText: 'Old source sentence.', baseTargetText: '' })
  const first = mergeIntoState(baseState([s]), [up('Brand new source sentence.')], META)
  const retry = mergeIntoState(baseState([s]), [up('Brand new source sentence.')], META)
  assert.equal(retry.history.length, 1)
  assert.deepEqual(retry.segments.map((x) => x.id), first.segments.map((x) => x.id))
})

test('two different runs append separate import history without duplicates', () => {
  const once = mergeIntoState(baseState([]), [up('A sentence.')], META)
  const twice = mergeIntoState(once, [up('A sentence.'), up('B sentence.')], { ...META, runId: 'run-2', mergedAt: 2000 })
  assert.equal(twice.history.length, 2)
  assert.equal(new Set(twice.history.map((h) => h.id)).size, 2)
})

test('resolved merge conflict not resurrected when upstream stable; concurrent conflict preserved', () => {
  const oldSource = 'Restart the pod after you update the network policy.'
  const newSource = 'Restart the controller pod after you update the network policy rules.'
  const s = seg('m1', oldSource, { targetText: '本地补充：先改网络策略，再重启 Pod', baseSourceText: oldSource, baseTargetText: '更新网络策略后重启 Pod' })
  const first = mergeIntoState(baseState([s]), [up(newSource)], META)
  assert.equal(first.conflicts.length, 1)
  const resolved = {
    ...first,
    conflicts: [],
    segments: [{ ...first.segments[0], sourceText: newSource, targetText: '本地补充：先改网络策略，再重启 Pod', baseSourceText: newSource, baseTargetText: '本地补充：先改网络策略，再重启 Pod' }],
  }
  const second = mergeIntoState(resolved, [up(newSource)], { ...META, runId: 'run-2' })
  assert.equal(second.conflicts.filter((c) => c.kind === 'merge').length, 0)
  const concurrent = { id: 'cf', segmentId: 'm1', localText: 'l', remoteText: 'r', remoteAuthor: 'a', createdAt: 1, kind: 'concurrent' }
  const withConcurrent = mergeIntoState({ ...first, conflicts: [concurrent] }, [up(newSource)], { ...META, runId: 'run-3' })
  assert.ok(withConcurrent.conflicts.some((c) => c.id === 'cf'))
})

test('restore removed segment returns translation and discussions', () => {
  const s = seg('z1', 'Removed content.', { targetText: '译文', status: 'confirmed', baseSourceText: 'Removed content.', baseTargetText: '译文' })
  const merged = mergeIntoState(baseState([s]), [], META)
  const restored = restoreRemoved(merged, merged.removedSegments[0], 2000)
  assert.equal(restored.segments[0].targetText, '译文')
  assert.equal(restored.segments[0].status, 'needs-work')
  assert.equal(restored.removedSegments.length, 0)
  assert.equal(restored.history[0].action, 'restore')
})

test('reordered segments detected by content signature as unchanged', () => {
  const segs = [
    seg('o1', 'First paragraph.', { baseSourceText: 'First paragraph.', baseTargetText: '一', targetText: '一' }),
    seg('o2', 'Second paragraph.', { baseSourceText: 'Second paragraph.', baseTargetText: '二', targetText: '二' }),
  ]
  const r = mergeIntoState(baseState(segs), [up('Second paragraph.'), up('First paragraph.')], META)
  assert.equal(r.summary.unchanged, 2)
  assert.deepEqual(r.segments.map((x) => x.id), ['o2', 'o1'])
})

test('distinct headings are not heuristic-paired; the dropped one is removed', () => {
  const s = seg('h1', '## Upgrade Notes', { targetText: '## 升级说明', status: 'confirmed', baseSourceText: '## Upgrade Notes', baseTargetText: '## 升级说明' })
  const r = mergeIntoState(baseState([s]), [up('## Rollback Strategy')], META)
  assert.equal(r.summary.added, 1)
  assert.equal(r.summary.removed, 1)
  assert.equal(r.removedSegments[0].segmentId, 'h1')
})

// 端到端：真实 parseMarkdown + 种子断网草稿 + 种子“上游更新”文档
test('seed: offline draft merges against the updated upstream document', () => {
  const state = { segments: seedSegments, discussions: seedDiscussions, removedSegments: [], conflicts: [], history: [] }
  const upstream = toUpstreamBlocks(parseMarkdown(seedUpstreamMarkdown))
  const r = mergeIntoState(state, upstream, { runId: 'seed', sourceFileName: 'docs/deployment.md', mergedAt: 7 })
  assert.deepEqual(r.summary, { unchanged: 7, reattached: 1, conflict: 1, added: 3, removed: 1 })
  assert.ok(r.segments.find((s) => s.id === 'seg-05').sourceText.includes('dedicated namespace'))
  assert.equal(r.segments.find((s) => s.id === 'seg-05').status, 'needs-work')
  assert.ok(r.conflicts.find((c) => c.segmentId === 'seg-08'))
  assert.ok(r.removedSegments.find((x) => x.segmentId === 'seg-10'))
  const retainedDiscussions = new Set(r.discussions.map((d) => d.segmentId))
  assert.ok(['seg-05', 'seg-02', 'seg-09'].every((id) => retainedDiscussions.has(id)))
})

console.log(`\n${tests} merge tests passed`)
