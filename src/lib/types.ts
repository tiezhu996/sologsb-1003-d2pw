export type SegmentKind = 'heading' | 'paragraph' | 'code' | 'link' | 'variable'
export type SegmentStatus = 'draft' | 'needs-work' | 'confirmed' | 'returned'
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
  /**
   * 片段的稳定标识。新格式的草稿会记录该值，旧稿没有该字段（undefined），
   * 此时合并回退到内容+顺序对齐，保证无基线的旧稿也能读入。
   */
  stableKey?: string
  /** 最近一次与上游同步时的原文，作为三方合并的基线；旧稿无此字段。 */
  baseSourceText?: string
  /** 最近一次与上游同步时的译文，作为三方合并的基线；旧稿无此字段。 */
  baseTargetText?: string
  /** 上游原文更新后、待译者处理前，暂存的旧原文，便于对照。 */
  previousSourceText?: string
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
  action: 'edit' | 'confirm' | 'return' | 'resolve-conflict' | 'import' | 'merge' | 'restore' | 'discussion'
  before: string
  after: string
  createdAt: number
}

export interface TranslationConflict {
  id: string
  segmentId: string
  /** 本地译文（可能对应旧原文）。 */
  localText: string
  /** 上游译文；纯原文合并时为更新后的上游原文。 */
  remoteText: string
  remoteAuthor: string
  createdAt: number
  /** 冲突来源：concurrent 为原有“本地 vs 远端译文”，merge 为本次重新导入产生。 */
  kind?: 'concurrent' | 'merge'
  /** 仅合并冲突：更新后的上游原文。 */
  upstreamSource?: string
  /** 仅合并冲突：更新前的原文。 */
  previousSource?: string
}

/** 上游已移除的片段，连同其译文、讨论与确认状态进入已移除清单。 */
export interface RemovedSegment {
  id: string
  segmentId: string
  kind: SegmentKind
  sourceText: string
  targetText: string
  status: SegmentStatus
  protectedTokens: string[]
  note: string
  stableKey?: string
  baseSourceText?: string
  baseTargetText?: string
  removedAt: number
  removedReason: string
  discussions: Discussion[]
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
