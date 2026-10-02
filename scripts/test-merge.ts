import assert from 'node:assert/strict'
import { applyMergeResult, mergeDocuments, type MergeInput } from '../src/lib/merge'
import type { Segment } from '../src/lib/types'

let passed = 0
const test = (name: string, fn: () => void) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const seg = (over: Partial<Segment> & Pick<Segment, 'id' | 'index' | 'kind' | 'sourceText' | 'targetText' | 'status'>): Segment => ({
  protectedTokens: [],
  note: '',
  ...over,
})

const baseSet = (s: Segment): Segment => ({ ...s, baselineSource: s.sourceText, baselineTarget: s.targetText })

/** 显式指定同步基线（本地译文已偏离基线时用）。 */
const withBase = (s: Segment, baseSource: string, baseTarget: string): Segment =>
  ({ ...s, baselineSource: baseSource, baselineTarget: baseTarget })

const run = (local: Segment[], upstream: Segment[], opts: Partial<MergeInput> = {}) =>
  mergeDocuments({ mergeId: 'm1', local, upstream, sourceName: 'docs/deploy.md', upstreamVersion: 'v2', now: 1_700_000_000_000, ...opts })

// 场景 1：原文没动 → 译文、确认状态保留
{
  const local = [baseSet(seg({ id: 'l1', index: 1, kind: 'paragraph', sourceText: 'Hello world.', targetText: '你好，世界。', status: 'confirmed' }))]
  const upstream = [seg({ id: 'u1', index: 1, kind: 'paragraph', sourceText: 'Hello world.', targetText: '你好，世界。', status: 'confirmed' })]
  const r = run(local, upstream)
  test('原文未动时保留译文与确认状态', () => {
    assert.equal(r.segments.length, 1)
    assert.equal(r.segments[0].targetText, '你好，世界。')
    assert.equal(r.segments[0].status, 'confirmed')
    assert.equal(r.report.unchanged, 1)
  })
  test('原文未动时讨论 id 映射到新片段', () => {
    assert.deepEqual(r.discussionIdMap, { l1: 'u1' })
  })
}

// 场景 2：原文变了、译文没改 → 接回新原文、退回待处理
{
  const local = [baseSet(seg({ id: 'l2', index: 1, kind: 'paragraph', sourceText: 'Old intro text here.', targetText: '旧的介绍文本。', status: 'confirmed' }))]
  const upstream = [seg({ id: 'u2', index: 1, kind: 'paragraph', sourceText: 'Old intro text here, updated!', targetText: '旧的介绍文本。', status: 'confirmed' })]
  const r = run(local, upstream)
  test('原文变化而译文未改：接回新原文并退回待处理', () => {
    assert.equal(r.segments[0].sourceText, 'Old intro text here, updated!')
    assert.equal(r.segments[0].targetText, '')
    assert.equal(r.segments[0].status, 'needs-work')
    assert.match(r.segments[0].note, /旧译文仅供参考：旧的介绍文本。/)
    assert.equal(r.report.sourceChanged, 1)
  })
}

// 场景 3：两边都改译文（原文未动）→ 冲突并列，均不覆盖
{
  const local = [withBase(seg({ id: 'l3', index: 1, kind: 'paragraph', sourceText: 'Same source sentence.', targetText: '本地新译文', status: 'draft' }), 'Same source sentence.', '基线译文')]
  const upstream = [seg({ id: 'u3', index: 1, kind: 'paragraph', sourceText: 'Same source sentence.', targetText: '上游新译文', status: 'draft' })]
  const r = run(local, upstream)
  test('双方都改译文：产出冲突且两边内容并列保留', () => {
    assert.equal(r.mergeConflicts.length, 1)
    assert.equal(r.mergeConflicts[0].reason, 'both-targets')
    assert.equal(r.mergeConflicts[0].localTarget, '本地新译文')
    assert.equal(r.mergeConflicts[0].upstreamTarget, '上游新译文')
    assert.equal(r.segments[0].targetText, '')
    assert.equal(r.segments[0].status, 'needs-work')
    assert.equal(r.report.conflicts, 1)
  })
}

// 场景 4：上游改原文 + 本地改译文 → source-and-target
{
  const local = [withBase(seg({ id: 'l4', index: 1, kind: 'paragraph', sourceText: 'Original base line.', targetText: '本地改过的译文', status: 'draft' }), 'Original base line.', '基线译文')]
  const upstream = [seg({ id: 'u4', index: 1, kind: 'paragraph', sourceText: 'Original base line rewritten.', targetText: '', status: 'draft' })]
  const r = run(local, upstream)
  test('上游改原文且本地改译文：并列保留新旧原文与双方译文', () => {
    assert.equal(r.mergeConflicts[0].reason, 'source-and-target')
    assert.equal(r.mergeConflicts[0].localSource, 'Original base line.')
    assert.equal(r.mergeConflicts[0].upstreamSource, 'Original base line rewritten.')
    assert.equal(r.mergeConflicts[0].localTarget, '本地改过的译文')
    assert.equal(r.segments[0].targetText, '')
  })
}

// 场景 5：新增片段 → 留空待译
{
  const local = [baseSet(seg({ id: 'l5', index: 1, kind: 'paragraph', sourceText: 'Only segment.', targetText: '唯一的片段。', status: 'confirmed' }))]
  const upstream = [
    seg({ id: 'u5a', index: 1, kind: 'paragraph', sourceText: 'Brand new opening.', targetText: '', status: 'draft' }),
    seg({ id: 'u5b', index: 2, kind: 'paragraph', sourceText: 'Only segment.', targetText: '唯一的片段。', status: 'confirmed' }),
  ]
  const r = run(local, upstream)
  test('上游新增片段留空待译，且排在新原文位置', () => {
    assert.equal(r.segments[0].targetText, '')
    assert.equal(r.segments[0].status, 'draft')
    assert.match(r.segments[0].note, /上游新增/)
    assert.equal(r.segments[1].targetText, '唯一的片段。')
    assert.equal(r.report.added, 1)
  })
}

// 场景 6：上游删除片段 → 带译文进入已移除清单
{
  const local = [
    baseSet(seg({ id: 'l6a', index: 1, kind: 'paragraph', sourceText: 'Stays here.', targetText: '保留。', status: 'confirmed' })),
    baseSet(seg({ id: 'l6b', index: 2, kind: 'paragraph', sourceText: 'Gets removed upstream.', targetText: '被删除片段的译文。', status: 'draft' })),
  ]
  const upstream = [seg({ id: 'u6', index: 1, kind: 'paragraph', sourceText: 'Stays here.', targetText: '保留。', status: 'confirmed' })]
  const r = run(local, upstream)
  test('上游移除片段带着译文进入已移除清单', () => {
    assert.equal(r.removedSegments.length, 1)
    assert.equal(r.removedSegments[0].id, 'l6b')
    assert.equal(r.removedSegments[0].targetText, '被删除片段的译文。')
    assert.equal(r.removedSegments[0].status, 'removed')
    assert.ok(r.removedSegments[0].removedAt)
    assert.equal(r.report.removed, 1)
  })
}

// 场景 7：仅上游改译文（本地没动）→ 快进
{
  const local = [baseSet(seg({ id: 'l7', index: 1, kind: 'paragraph', sourceText: 'Source text.', targetText: '基线译文', status: 'confirmed' }))]
  const upstream = [seg({ id: 'u7', index: 1, kind: 'paragraph', sourceText: 'Source text.', targetText: '上游修订译文', status: 'confirmed' })]
  const r = run(local, upstream)
  test('仅上游更新译文时快进，不产生冲突', () => {
    assert.equal(r.segments[0].targetText, '上游修订译文')
    assert.equal(r.report.fastForwarded, 1)
    assert.equal(r.mergeConflicts.length, 0)
  })
}

// 场景 8：重复句按出现顺序区分，不跨位错挂
{
  const mk = (id: string, index: number, target: string, status: Segment['status']) =>
    baseSet(seg({ id, index, kind: 'paragraph', sourceText: 'Repeat this line.', targetText: target, status }))
  const local = [mk('d1', 1, '第一处译文', 'confirmed'), mk('d2', 2, '第二处译文', 'confirmed')]
  // 中间插入新片段，两句重复句都保留
  const upstream = [
    seg({ id: 'e1', index: 1, kind: 'paragraph', sourceText: 'Repeat this line.', targetText: '第一处译文', status: 'confirmed' }),
    seg({ id: 'e2', index: 2, kind: 'paragraph', sourceText: 'INSERTED.', targetText: '', status: 'draft' }),
    seg({ id: 'e3', index: 3, kind: 'paragraph', sourceText: 'Repeat this line.', targetText: '第二处译文', status: 'confirmed' }),
  ]
  const r = run(local, upstream)
  test('重复句按顺序一一挂接，插入的新片段留空', () => {
    assert.equal(r.segments[0].targetText, '第一处译文')
    assert.equal(r.segments[1].targetText, '')
    assert.equal(r.segments[2].targetText, '第二处译文')
    assert.deepEqual(r.discussionIdMap, { d1: 'e1', d2: 'e3' })
  })
}

// 场景 9：旧稿没有基线
{
  const legacy = (id: string, sourceText: string, targetText: string) =>
    seg({ id, index: 1, kind: 'paragraph', sourceText, targetText, status: 'draft' })
  test('旧稿无基线且原文一致：兼容读入并保留译文', () => {
    const local = [legacy('g1', 'Identical source.', '旧稿译文')]
    const upstream = [seg({ id: 'n1', index: 1, kind: 'paragraph', sourceText: 'Identical source.', targetText: '旧稿译文', status: 'draft' })]
    const r = run(local, upstream)
    assert.equal(r.segments[0].targetText, '旧稿译文')
    assert.equal(r.mergeConflicts.length, 0)
  })
  test('旧稿无基线且原文不同且有译文：进入冲突，数据不丢', () => {
    const local = [legacy('g2', 'Totally different old source.', '旧稿的翻译')]
    const upstream = [seg({ id: 'n2', index: 1, kind: 'paragraph', sourceText: 'Completely new upstream wording.', targetText: '', status: 'draft' })]
    const r = run(local, upstream)
    assert.equal(r.mergeConflicts[0].reason, 'legacy-no-baseline')
    assert.equal(r.mergeConflicts[0].orphanLocal, true)
    assert.equal(r.mergeConflicts[0].localTarget, '旧稿的翻译')
    // 译文同时保留在已移除清单兜底，任何路径都不丢
    assert.equal(r.removedSegments[0].targetText, '旧稿的翻译')
  })
  test('旧稿无基线、原文不同但译文为空：直接接新原文，不产生冲突', () => {
    const local = [legacy('g3', 'Old untranslated.', '')]
    const upstream = [seg({ id: 'n3', index: 1, kind: 'paragraph', sourceText: 'New untranslated.', targetText: '', status: 'draft' })]
    const r = run(local, upstream)
    assert.equal(r.mergeConflicts.length, 0)
    assert.equal(r.segments[0].sourceText, 'New untranslated.')
    assert.equal(r.report.sourceChanged, 1)
  })
}

// 场景 10：代码块边界——代码内容变化仍挂回同一逻辑片段
{
  const local = [baseSet(seg({ id: 'c1', index: 1, kind: 'code', sourceText: '```bash\nkubectl apply -f old.yaml\n```', targetText: '```bash\nkubectl apply -f old.yaml\n```', status: 'confirmed' }))]
  const upstream = [seg({ id: 'c2', index: 1, kind: 'code', sourceText: '```bash\nkubectl apply -f new.yaml\n```', targetText: '', status: 'draft' })]
  const r = run(local, upstream)
  test('代码块内容更新：挂回同一片段并退回待处理（不当作新增+删除）', () => {
    assert.equal(r.segments.length, 1)
    assert.equal(r.segments[0].sourceText, '```bash\nkubectl apply -f new.yaml\n```')
    assert.equal(r.segments[0].status, 'needs-work')
    assert.equal(r.removedSegments.length, 0)
    assert.equal(r.report.sourceChanged, 1)
  })
}

// 场景 11：占位符边界——仅变量名/URL 变化靠骨架挂回
{
  const local = [baseSet(seg({ id: 'v1', index: 1, kind: 'variable', sourceText: 'Deploy {{old_name}} to the cluster now.', targetText: '立即把 {{old_name}} 部署到集群。', status: 'confirmed', protectedTokens: ['{{old_name}}'] }))]
  const upstream = [seg({ id: 'v2', index: 1, kind: 'variable', sourceText: 'Deploy {{new_name}} to the cluster now.', targetText: '', status: 'draft', protectedTokens: ['{{new_name}}'] })]
  const r = run(local, upstream)
  test('占位符变化时按骨架挂回，本地译文未改则退回待处理', () => {
    assert.equal(r.segments.length, 1)
    assert.equal(r.segments[0].status, 'needs-work')
    assert.deepEqual(r.segments[0].protectedTokens, ['{{new_name}}'])
  })
}

// 场景 12：短标题换词（顺序对齐兜底）
{
  const local = [baseSet(seg({ id: 'h1', index: 1, kind: 'heading', sourceText: '## Prerequisites', targetText: '## 前置条件', status: 'confirmed' }))]
  const upstream = [seg({ id: 'h2', index: 1, kind: 'heading', sourceText: '## Requirements', targetText: '', status: 'draft' })]
  const r = run(local, upstream)
  test('短标题改写仍挂回同一片段并退回待处理', () => {
    assert.equal(r.segments.length, 1)
    assert.equal(r.segments[0].status, 'needs-work')
    assert.equal(r.removedSegments.length, 0)
  })
}

// 场景 13：检查点重试幂等
{
  const local = [
    baseSet(seg({ id: 'p1', index: 1, kind: 'paragraph', sourceText: 'A.', targetText: '甲', status: 'confirmed' })),
    withBase(seg({ id: 'p2', index: 2, kind: 'paragraph', sourceText: 'B base.', targetText: '乙本地', status: 'draft' }), 'B base.', '乙基线'),
  ]
  const upstream = [
    seg({ id: 'q1', index: 1, kind: 'paragraph', sourceText: 'A.', targetText: '甲', status: 'confirmed' }),
    seg({ id: 'q2', index: 2, kind: 'paragraph', sourceText: 'B base changed.', targetText: '', status: 'draft' }),
  ]
  const first = run(local, upstream, { mergeId: 'fixed-id' })
  const second = run(local, upstream, { mergeId: 'fixed-id' })
  test('同一 mergeId 重试：历史 id 完全一致', () => {
    assert.deepEqual(first.historyEntries.map((h) => h.id), second.historyEntries.map((h) => h.id))
  })
  test('applyMergeResult 重复应用不产生重复历史', () => {
    let state = { history: [] as typeof first.historyEntries }
    state = applyMergeResult(state, first)
    const countAfterFirst = state.history.length
    state = applyMergeResult(state, second)
    assert.equal(state.history.length, countAfterFirst)
    const ids = state.history.map((h) => h.id)
    assert.equal(new Set(ids).size, ids.length)
  })
}

// 场景 14：上游 previousSegments 作为基线来源（文件导入无内嵌基线时）
{
  const previous = [seg({ id: 'b1', index: 1, kind: 'paragraph', sourceText: 'Base source.', targetText: '基线译文', status: 'draft' })]
  const local = [seg({ id: 'l1', index: 1, kind: 'paragraph', sourceText: 'Base source.', targetText: '基线译文', status: 'draft' })]
  const upstream = [seg({ id: 'u1', index: 1, kind: 'paragraph', sourceText: 'Base source plus new words.', targetText: '', status: 'draft' })]
  const r = run(local, upstream, { upstreamPrevious: previous })
  test('使用上游上一版快照做基线：原文变译文未改 → 退回待处理', () => {
    assert.equal(r.segments[0].status, 'needs-work')
    assert.equal(r.segments[0].sourceText, 'Base source plus new words.')
    assert.equal(r.mergeConflicts.length, 0)
  })
}

console.log(`\n${passed} 项合并引擎测试全部通过 ✅`)
