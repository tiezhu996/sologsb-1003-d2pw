export type SegmentKind = 'heading' | 'paragraph' | 'code' | 'link' | 'variable'
export type SegmentStatus = 'draft' | 'needs-work' | 'confirmed' | 'returned' | 'removed'
export type IssueType = 'missing-translation' | 'missing-variable' | 'link-mismatch' | 'glossary' | 'code-format'
export type IssueSeverity = 'error' | 'warning'

export interface Segment {
  id: string
  index: number
  kind: SegmentKind
  sourceText: string
  targetText: string
  status: SegmentStatus
  protectedTokens: string[]
  note: string
  /** 上次与上游同步时的原文基线，三向合并据此判断原文是否变化。旧稿可能没有。 */
  baselineSource?: string
  /** 上次与上游同步时的译文基线，三向合并据此判断译文是否被本地/上游改动。 */
  baselineTarget?: string
  /** 跨版本稳定标识：按原文指纹生成，重复句按出现顺序区分。 */
  stableId?: string
  /** 上游已移除、带着译文进入已移除清单的时间戳。 */
  removedAt?: number
}

export interface GlossaryTerm {
  id: string
  source: string
  target: string
  caseSensitive: boolean
  note: string
}

export interface Discussion {
  id: string
  segmentId: string
  author: string
  body: string
  resolved: boolean
  createdAt: number
}

export interface TranslationIssue {
  id: string
  segmentId: string
  type: IssueType
  severity: IssueSeverity
  message: string
  expected?: string
}

export interface HistoryEntry {
  id: string
  segmentId: string
  author: string
  action: 'edit' | 'confirm' | 'return' | 'resolve-conflict' | 'import' | 'discussion' | 'merge'
  before: string
  after: string
  createdAt: number
}

export interface TranslationConflict {
  id: string
  segmentId: string
  localText: string
  remoteText: string
  remoteAuthor: string
  createdAt: number
}

/** 三向合并产生的冲突：本地与上游都改过，并列保留两边内容，处理前不覆盖任何一侧。 */
export interface MergeConflict {
  id: string
  stableId: string
  index: number
  kind: SegmentKind
  reason: 'both-targets' | 'source-and-target' | 'legacy-no-baseline'
  localSource: string
  upstreamSource: string
  localTarget: string
  upstreamTarget: string
  protectedTokens: string[]
  localNote: string
  upstreamNote: string
  remoteAuthor: string
  createdAt: number
  /** 旧稿挂不上、上游也没有对应片段：为 true，解决时只能保留或丢弃本地译文。 */
  orphanLocal?: boolean
  /** orphanLocal 冲突解决后若选择保留本地译文，挂到这个新片段 id；否则随已移除清单保留。 */
  segmentId?: string
}

export interface MergeReport {
  mergeId: string
  sourceName: string
  upstreamVersion: string | number
  /** 原文未动、原样保留译文/讨论/确认状态的片段数。 */
  unchanged: number
  /** 上游仅改译文（本地未动）而快进到上游译文的片段数。 */
  fastForwarded: number
  /** 原文变化而本地译文未改，接回新原文并退回待处理的片段数。 */
  sourceChanged: number
  /** 两边都改过、并列待决的冲突数。 */
  conflicts: number
  /** 上游新增、留空待译的片段数。 */
  added: number
  /** 上游移除、带着译文进入已移除清单的片段数。 */
  removed: number
  finishedAt: number
}

export interface MergeResult {
  segments: Segment[]
  removedSegments: Segment[]
  mergeConflicts: MergeConflict[]
  /** 合并成功后的新基线（即上游版本快照）。 */
  baseline: Segment[]
  /** 旧片段 id → 新片段 id，用于迁移讨论等按片段挂接的数据。 */
  discussionIdMap: Record<string, string>
  report: MergeReport
  /** 幂等历史记录：同一 mergeId 重试只允许落库一次。 */
  historyEntries: HistoryEntry[]
}

/** 上游发布版本；previousSegments 为上一版快照（基线），旧稿/文件导入可能缺省。 */
export interface UpstreamDocument {
  id: string
  title: string
  sourceFile: string
  updatedAt: number
  version: string
  segments: Segment[]
  previousSegments?: Segment[]
}

export interface LocalizationDocument {
  id: string
  title: string
  sourceFile: string
  sourceLanguage: string
  targetLanguage: string
  updatedAt: number
  segments: Segment[]
  glossary: GlossaryTerm[]
  discussions: Discussion[]
}
