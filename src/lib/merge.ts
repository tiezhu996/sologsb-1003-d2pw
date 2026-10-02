import type {
  Discussion, HistoryEntry, RemovedSegment, Segment, SegmentKind, TranslationConflict,
} from './types'

/**
 * 断网草稿与更新后的上游文档做三方合并的纯函数模块。
 *
 * 角色：
 * - base（基线）：上次与上游同步时的原文/译文，记录在 segment.baseSourceText / baseTargetText；
 * - local（本地）：断网期间草稿里的原文/译文；
 * - upstream（上游）：本次重新导入的新原文（parseMarkdown 的结果）。
 *
 * 判定规则：
 * - 原文未变：整段保留（译文、讨论、确认状态）。
 * - 原文变了、本地译文未偏离基线：接回新原文，译文保留，状态退回“待处理”。
 * - 原文变了、本地译文也改过：不覆盖，生成并列冲突，处理前保留双方内容。
 * - 上游新增：留空待译。
 * - 上游移除：连同译文、讨论、状态进入已移除清单。
 *
 * 挂接方式：稳定标识（内容哈希）做 LCS 锚点，代码块/占位符作为 kind 边界参与
 * 空隙对齐；重复句由 LCS 按出现顺序一一配对。所有产物 id 均由输入确定性推导，
 * 因此检查点重试不会产生重复片段或重复历史。
 */

export interface ParsedUpstreamBlock {
  index: number
  kind: SegmentKind
  sourceText: string
  protectedTokens: string[]
  stableKey: string
}

export type MergeOutcome = 'unchanged' | 'reattached' | 'conflict' | 'added' | 'removed'

export interface MergeSummary {
  unchanged: number
  reattached: number
  conflict: number
  added: number
  removed: number
}

export interface MergeState {
  segments: Segment[]
  discussions: Discussion[]
  removedSegments: RemovedSegment[]
  conflicts: TranslationConflict[]
  history: HistoryEntry[]
}

export interface MergeResult extends MergeState {
  summary: MergeSummary
  addedHistory: HistoryEntry[]
}

export interface MergeMeta {
  runId: string
  sourceFileName: string
  mergedAt: number
}

/** 合并中断后保留的检查点，重试始终从 before 重新计算。 */
export interface MergeCheckpoint {
  runId: string
  sourceFileName: string
  upstreamChecksum: string
  startedAt: number
  attempt: number
  simulateFailure: boolean
  upstream: ParsedUpstreamBlock[]
  before: MergeState
}

// ---------------------------------------------------------------------------
// 稳定标识
// ---------------------------------------------------------------------------

/** 归一化：统一换行、去掉每行首尾空白与多余空行，避免编辑器噪音改变标识。 */
export const normalizeContent = (text: string): string =>
  text
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** 宽松归一化：用于“译文是否改过”的比较，所有连续空白视为等价。 */
const looseNormalize = (text: string): string => normalizeContent(text).replace(/\s+/g, ' ')

/** djb2 32 位哈希，输出 base36。 */
export const contentHash = (text: string): string => {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = (((hash << 5) + hash) + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/**
 * 片段稳定标识：kind 边界（标题/段落/代码块/链接/占位符）+ 归一化内容哈希。
 * 占位符与链接 URL 原样参与哈希，代码块整体作为一个边界。
 */
export const computeStableKey = (sourceText: string, kind: SegmentKind): string =>
  `${kind}-${contentHash(normalizeContent(sourceText))}`

/**
 * 内容签名：只依赖归一化文本。同一原文在不同解析版本下可能被标成 paragraph/variable
 * （例如含 {{变量}} 的段落），挂接以内容为准；kind 仅作为代码块/占位符的边界启发式。
 */
export const contentSignature = (sourceText: string): string => contentHash(normalizeContent(sourceText))

export const toUpstreamBlocks = (segments: Pick<Segment, 'index' | 'kind' | 'sourceText' | 'protectedTokens'>[]): ParsedUpstreamBlock[] =>
  segments.map((segment) => ({
    index: segment.index,
    kind: segment.kind,
    sourceText: segment.sourceText,
    protectedTokens: segment.protectedTokens,
    stableKey: computeStableKey(segment.sourceText, segment.kind),
  }))

// -------------------------------------------------------------------------
// 序列对齐：先按稳定标识做 LCS 锚点，空隙内再按 kind（代码块/占位符边界）对齐
// -------------------------------------------------------------------------

type Alignment =
  | { outcome: 'unchanged' | 'reattached' | 'conflict'; local: Segment; up: ParsedUpstreamBlock }
  | { outcome: 'added'; up: ParsedUpstreamBlock }
  | { outcome: 'removed'; local: Segment }

interface LocalRow {
  segment: Segment
  /** 仅内容签名，用于跨 kind 版本差异的挂接。 */
  signature: string
  legacy: boolean
}

const lcsPairs = (a: string[], b: string[]): Array<[number, number]> => {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1 }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1
    else j += 1
  }
  return pairs
}

const classifyPair = (local: Segment, up: ParsedUpstreamBlock, legacy: boolean): Alignment => {
  const baseSource = local.baseSourceText ?? local.sourceText
  const baseTarget = local.baseTargetText ?? ''
  const sourceChanged = looseNormalize(up.sourceText) !== looseNormalize(baseSource)
  const targetTouched = looseNormalize(local.targetText) !== looseNormalize(baseTarget)

  if (!sourceChanged) return { outcome: 'unchanged', local, up }

  // 代码块不是译文：只要本地没有手工改动，直接同步为上游新内容。
  if (local.kind === 'code' && !targetTouched) {
    return { outcome: 'reattached', local: { ...local, targetText: up.sourceText }, up }
  }

  // 旧稿没有基线，无法判断译文是否改过；保守按“接回 + 待处理”，仍保留原译文等人复核。
  if (legacy) return { outcome: 'reattached', local, up }

  if (!targetTouched) return { outcome: 'reattached', local, up }

  // 原文与译文两边都改过：并列保留，处理前不覆盖。
  return { outcome: 'conflict', local, up }
}

/**
 * kind 启发式只在“改动片段”上使用，必须同时满足最低内容相似度，
 * 避免把两段不相干的标题/段落错配（如 “## Upgrade Notes” 与 “## Rollback Strategy”）。
 */
const enoughOverlap = (a: string, b: string): boolean => {
  const tokenize = (text: string) => new Set(
    normalizeContent(text)
      .toLowerCase()
      .replace(/[#`*_>()[\](){}]/g, ' ')
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((token) => token.length > 1),
  )
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (!setA.size || !setB.size) return false
  let common = 0
  setA.forEach((token) => { if (setB.has(token)) common += 1 })
  const smaller = Math.min(setA.size, setB.size)
  return common / smaller >= 0.34
}

/**
 * 空隙内无相同稳定标识时，按 kind 做一次 LCS，给出“改动片段”的启发式配对，
 * 仅在锚点之间的局部空隙内进行，避免跨锚点误配；再用内容相似度过滤不相干片段。
 */
const kindPairsInGap = (
  rows: LocalRow[],
  locals: number[],
  upstream: ParsedUpstreamBlock[],
  ups: number[],
  blockedLocal: Set<number>,
  blockedUp: Set<number>,
): Array<[number, number]> => {
  const li = locals.filter((index) => !blockedLocal.has(index))
  const uj = ups.filter((index) => !blockedUp.has(index))
  // 先给 LCS 一个相似度代价：结构性边界同 kind 即可配对；段落还需内容足够相似。
  const cost = li.map((a) => uj.map((b) => {
    const sameKind = rows[a].segment.kind === upstream[b].kind
    if (!sameKind) return 0
    // 代码块/链接/占位符常整体改写、词重叠不稳定，同 kind 边界即可配对。
    if (rows[a].segment.kind === 'code' || rows[a].segment.kind === 'link' || rows[a].segment.kind === 'variable') return 1
    // 标题与段落再用词重叠相似度过滤，避免不相干内容错配。
    return enoughOverlap(rows[a].segment.sourceText, upstream[b].sourceText) ? 1 : 0
  }))
  const weighted = weightedLcs(cost)
  return weighted.map(([a, b]) => [li[a], uj[b]] as [number, number])
}

/** 对 0/1 代价矩阵取总权值最大的单调配对（DAG 最长路径）。 */
const weightedLcs = (score: number[][]): Array<[number, number]> => {
  const n = score.length
  const m = score[0]?.length ?? 0
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = Math.max(score[i][j] + dp[i + 1][j + 1], dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (score[i][j] > 0 && dp[i][j] > 0 && score[i][j] + dp[i + 1][j + 1] >= Math.max(dp[i + 1][j], dp[i][j + 1])) {
      pairs.push([i, j]); i += 1; j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1
    else j += 1
  }
  return pairs
}

const alignRows = (rows: LocalRow[], upstream: ParsedUpstreamBlock[]): Alignment[] => {
  const localSignatures = rows.map((row) => row.signature)
  const upSignatures = upstream.map((block) => contentSignature(block.sourceText))

  // 第一轮：内容签名全局 LCS，作为主锚点。
  const anchorPairs = lcsPairs(localSignatures, upSignatures)
  const pairedUp = new Map<number, number>()
  const pairedLocal = new Set<number>()
  for (const [li, uj] of anchorPairs) { pairedUp.set(uj, li); pairedLocal.add(li) }

  // 第二轮：未配对残差再按内容签名做一次 LCS。
  // 这样纯移动（锚点两侧的重排、重复句换位）也能跨锚点接回，且重复句按顺序配对。
  const freeLocal = rows.map((_, i) => i).filter((i) => !pairedLocal.has(i))
  const freeUp = upstream.map((_, j) => j).filter((j) => !pairedUp.has(j))
  const residualPairs = lcsPairs(freeLocal.map((i) => localSignatures[i]), freeUp.map((j) => upSignatures[j]))
  for (const [a, b] of residualPairs) {
    const li = freeLocal[a]
    const uj = freeUp[b]
    pairedUp.set(uj, li)
    pairedLocal.add(li)
  }

  // 第三轮：锚点之间的空隙内，剩余改动片段按 kind（代码块/占位符边界）启发式配对。
  const anchors = [...pairedUp.entries()].map(([uj, li]) => [li, uj] as [number, number]).sort((a, b) => a[0] - b[0])
  let cursorLi = 0
  let cursorUj = 0
  for (const [anchorLi, anchorUj] of [...anchors, [rows.length, upstream.length]]) {
    const gapLocal = range(cursorLi, anchorLi)
    const gapUp = range(cursorUj, anchorUj)
    for (const [li, uj] of kindPairsInGap(rows, gapLocal, upstream, gapUp, pairedLocal, new Set(pairedUp.keys()))) {
      pairedUp.set(uj, li)
      pairedLocal.add(li)
    }
    cursorLi = anchorLi + 1
    cursorUj = anchorUj + 1
  }

  // 输出顺序严格跟随上游；每个上游块恰好产出一个活动片段。
  const result: Alignment[] = []
  upstream.forEach((block, uj) => {
    const li = pairedUp.get(uj)
    if (li === undefined) { result.push({ outcome: 'added', up: block }); return }
    const row = rows[li]
    const alignment = classifyPair(row.segment, block, row.legacy)
    result.push(alignment.outcome === 'unchanged' ? { outcome: 'unchanged', local: row.segment, up: block } : alignment)
  })
  rows.forEach((row, li) => { if (!pairedLocal.has(li)) result.push({ outcome: 'removed', local: row.segment }) })
  return result
}

const range = (from: number, to: number): number[] => {
  const values: number[] = []
  for (let i = from; i < to; i += 1) values.push(i)
  return values
}

// ---------------------------------------------------------------------------
// 合并主体
// ---------------------------------------------------------------------------

const newSegmentId = (up: ParsedUpstreamBlock, occurrence: number): string =>
  `seg-${contentHash(up.stableKey)}${occurrence > 0 ? `-${occurrence}` : ''}`

const buildReattached = (local: Segment, up: ParsedUpstreamBlock): Segment => ({
  ...local,
  index: up.index,
  kind: up.kind,
  sourceText: up.sourceText,
  protectedTokens: up.protectedTokens,
  status: 'needs-work',
  previousSourceText: local.sourceText,
  stableKey: up.stableKey,
  baseSourceText: up.sourceText,
  baseTargetText: local.targetText,
})

const buildAdded = (up: ParsedUpstreamBlock, duplicateCount: number): Segment => ({
  id: newSegmentId(up, duplicateCount),
  index: up.index,
  kind: up.kind,
  sourceText: up.sourceText,
  targetText: '',
  status: 'draft',
  protectedTokens: up.protectedTokens,
  note: '',
  stableKey: up.stableKey,
  baseSourceText: up.sourceText,
  baseTargetText: '',
})

const buildConflict = (local: Segment, up: ParsedUpstreamBlock): TranslationConflict => ({
  id: `merge-conflict-${local.id}`,
  segmentId: local.id,
  localText: local.targetText,
  remoteText: up.sourceText,
  remoteAuthor: '上游文档更新',
  createdAt: 0,
  kind: 'merge',
  upstreamSource: up.sourceText,
  previousSource: local.sourceText,
})

export const mergeIntoState = (state: MergeState, upstream: ParsedUpstreamBlock[], meta: MergeMeta): MergeResult => {
  const rows: LocalRow[] = state.segments.map((segment) => ({
    segment,
    // 对齐基于本地当前原文（含 kind 版本差异时仍能挂接）；基线用于 classifyPair 判断改动。
    signature: contentSignature(segment.sourceText),
    legacy: segment.stableKey === undefined && segment.baseSourceText === undefined,
  }))
  const alignment = alignRows(rows, upstream)

  // 上游重复句的出现次序（第 0 次不带后缀）。
  const keySeen = new Map<string, number>()
  const outputSegments: Segment[] = []
  const newConflicts: TranslationConflict[] = []
  const conflictSegmentIds = new Set<string>()
  const summary: MergeSummary = { unchanged: 0, reattached: 0, conflict: 0, added: 0, removed: 0 }

  // 输出顺序严格跟随上游；每个上游块恰好产出一个活动片段。
  for (const item of alignment) {
    if (item.outcome === 'added') {
      const seen = keySeen.get(item.up.stableKey) ?? 0
      keySeen.set(item.up.stableKey, seen + 1)
      outputSegments.push(buildAdded(item.up, seen))
      summary.added += 1
    } else if (item.outcome === 'unchanged') {
      outputSegments.push({
        ...item.local,
        index: item.up.index,
        kind: item.up.kind,
        protectedTokens: item.up.protectedTokens,
        stableKey: item.up.stableKey,
      })
      summary.unchanged += 1
    } else if (item.outcome === 'reattached') {
      outputSegments.push(buildReattached(item.local, item.up))
      summary.reattached += 1
    } else if (item.outcome === 'conflict') {
      // 冲突：本地片段原样保留（旧原文 + 本地译文），不覆盖。
      outputSegments.push({ ...item.local, index: item.up.index })
      const conflict = buildConflict(item.local, item.up)
      newConflicts.push({ ...conflict, createdAt: meta.mergedAt })
      conflictSegmentIds.add(item.local.id)
      summary.conflict += 1
    }
  }
  outputSegments.forEach((segment, index) => { segment.index = index + 1 })

  const removed: RemovedSegment[] = []
  const removedIds = new Set<string>()
  for (const item of alignment) {
    if (item.outcome !== 'removed') continue
    const segment = item.local
    const discussions = state.discussions.filter((discussion) => discussion.segmentId === segment.id)
    removed.push({
      id: `removed-${segment.id}`,
      segmentId: segment.id,
      kind: segment.kind,
      sourceText: segment.sourceText,
      targetText: segment.targetText,
      status: segment.status,
      protectedTokens: segment.protectedTokens,
      note: segment.note,
      stableKey: segment.stableKey,
      baseSourceText: segment.baseSourceText,
      baseTargetText: segment.baseTargetText,
      removedAt: meta.mergedAt,
      removedReason: '上游文档已移除该片段',
      discussions,
    })
    removedIds.add(segment.id)
    summary.removed += 1
  }

  // 讨论跟随片段：移除片段的讨论进入已移除记录，其余保留；新增片段天然无讨论。
  const keptDiscussions = state.discussions.filter((discussion) => !removedIds.has(discussion.segmentId))

  // 同一文档此前的“合并冲突”按当前对齐重建（id 确定性，重试不重复）；并发冲突原样保留。
  const concurrentConflicts = state.conflicts.filter((conflict) => (conflict.kind ?? 'concurrent') === 'concurrent')
  const conflicts = [...concurrentConflicts, ...newConflicts]

  // 历史登记：本次导入条目固定追加一次（确定性 id），再拼接此前历史。
  // 重试（同一 runId 从 before 重算）与再次合并（新 runId）都不会产生重复条目。
  const summaryText = summarizeMerge(summary, meta.sourceFileName)
  const importEntry: HistoryEntry = {
    id: `merge-import-${meta.runId}`,
    segmentId: outputSegments[0]?.id ?? '',
    author: '合并检查点',
    action: 'import',
    before: meta.sourceFileName,
    after: summaryText,
    createdAt: meta.mergedAt,
  }
  const earlierHistory = state.history.filter((entry) => entry.id !== importEntry.id)
  const history = [importEntry, ...earlierHistory]

  return {
    segments: outputSegments,
    discussions: keptDiscussions,
    removedSegments: [...removed, ...state.removedSegments.filter((record) => !removedIds.has(record.segmentId))],
    conflicts,
    history,
    summary,
    addedHistory: [importEntry],
  }
}

export const summarizeMerge = (summary: MergeSummary, sourceFileName: string): string =>
  `合并导入 ${sourceFileName}：保留 ${summary.unchanged}、接回 ${summary.reattached}、并列冲突 ${summary.conflict}、新增 ${summary.added}、移除 ${summary.removed}`

/** 从已移除清单恢复片段：译文与讨论一并回到工作区末尾，状态退回待处理。 */
export const restoreRemoved = (state: MergeState, record: RemovedSegment, restoredAt: number): MergeState & { restored: Segment } => {
  const restored: Segment = {
    id: record.segmentId,
    index: state.segments.length + 1,
    kind: record.kind,
    sourceText: record.sourceText,
    targetText: record.targetText,
    status: 'needs-work',
    protectedTokens: record.protectedTokens,
    note: record.note,
    stableKey: record.stableKey,
    baseSourceText: record.baseSourceText,
    baseTargetText: record.baseTargetText,
  }
  return {
    segments: [...state.segments, restored],
    discussions: [...record.discussions, ...state.discussions],
    removedSegments: state.removedSegments.filter((item) => item.id !== record.id),
    conflicts: state.conflicts,
    history: [{
      id: `restore-${record.segmentId}-${restoredAt}`,
      segmentId: restored.id,
      author: '当前用户',
      action: 'restore',
      before: record.removedReason,
      after: record.targetText || record.sourceText,
      createdAt: restoredAt,
    }, ...state.history],
    restored,
  }
}
