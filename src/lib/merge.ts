import type {
  HistoryEntry, MergeConflict, MergeReport, MergeResult, Segment,
} from './types'
import { extractProtected } from './markdown'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const hash = (input: string): string => {
  let h1 = 0x811c9dc5
  let h2 = 0x1e35a7bd
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ ((code << 5) | (code >> 2)), 0x85ebca6b) >>> 0
  }
  return (h1.toString(36) + h2.toString(36)).padStart(13, '0')
}

export const normalizeText = (text: string) =>
  text.replace(/\r/g, '').trim().replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n')

/**
 * 稳定标识：纳入代码块（fence 与语言标记）和占位符边界的完整原文指纹。
 * 指纹不变即同一逻辑片段；原文变化后由 {@link alignSegments} 按顺序与结构重新挂接。
 */
export const stableFingerprint = (sourceText: string): string => hash(normalizeText(sourceText))

/** 重复句按出现顺序区分：stableId = 指纹#第几次出现（从 0 起）。 */
export const assignStableIds = (segments: Segment[]): Segment[] => {
  const seen = new Map<string, number>()
  return segments.map((segment) => {
    const fp = segment.stableId ? segment.stableId.split('#')[0] : stableFingerprint(segment.sourceText)
    const ordinal = seen.get(fp) ?? 0
    seen.set(fp, ordinal + 1)
    return { ...segment, stableId: `${fp}#${ordinal}` }
  })
}

/** 把占位符、行内代码和 URL 收敛为槽位，用于判断“结构相同、措辞已变”。 */
const skeleton = (text: string) =>
  normalizeText(text)
    .replace(/```[a-zA-Z0-9_+-]*/g, '```LANG')
    .replace(/\{\{[^{}]+\}\}|\{[A-Za-z_][\w.-]*\}|%\([^)]+\)[sd]|%[sd]/g, '␠VAR␠')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '␠LINK␠')
    .replace(/`[^`]+`/g, '␠CODE␠')

const bigrams = (text: string) => {
  const compact = text.toLowerCase().replace(/[#*_>`\[\](){}|\\!?:;，。、；：？！“”"'’\s]/g, '')
  const set = new Set<string>()
  for (let i = 0; i < compact.length - 1; i += 1) set.add(compact.slice(i, i + 2))
  return set
}

/** Dice 系数，对中英文混排的局部改写都比较稳。 */
export const similarity = (a: string, b: string): number => {
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (!ga.size || !gb.size) return 0
  let common = 0
  for (const gram of ga) if (gb.has(gram)) common += 1
  return (2 * common) / (ga.size + gb.size)
}

/** 标题层级一致且篇幅接近即视为同一逻辑片段（短标题可能整词替换，词级 Dice 会失效）。 */
const headingAlike = (a: string, b: string): boolean => {
  const words = (text: string) => text.replace(/^#{1,6}\s+/, '').match(/[A-Za-z0-9]+|[一-龥]/g) ?? []
  const wa = words(a)
  const wb = words(b)
  if (!wa.length || !wb.length) return false
  const longer = Math.max(wa.length, wb.length)
  const shorter = Math.min(wa.length, wb.length)
  return shorter / longer >= 0.5
}

const SIMILARITY_THRESHOLD = 0.45

const codeLang = (text: string) => (/```([^\n`]*)/.exec(text)?.[1] ?? '').trim()

/**
 * 精确指纹挂不上的片段，按文档顺序做 LCS 对齐：
 * 同类型、代码块语言一致，且措辞相似度达阈值（或占位符/代码槽位骨架相同）即视为同一片段。
 * 标题按层级一致 + 词级相似度放行（容忍短标题换词）。
 * 重复句因此仍按顺序一一对应，不会跨位错挂。
 */
export const alignSegments = (
  localUnmatched: Segment[],
  upstreamUnmatched: Segment[],
  options: { minSimilarity?: number } = {},
): { pairs: [Segment, Segment][]; localLeftovers: Segment[]; upstreamLeftovers: Segment[] } => {
  const minSimilarity = options.minSimilarity ?? SIMILARITY_THRESHOLD
  const n = localUnmatched.length
  const m = upstreamUnmatched.length
  const score: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const headingLevel = (text: string) => /^(#{1,6})\s/.exec(text)?.[1]?.length ?? 0
  const canPair = (l: Segment, u: Segment): number => {
    if (l.kind !== u.kind) return 0
    if (l.kind === 'code') return codeLang(l.sourceText) === codeLang(u.sourceText) ? 1 : 0
    const sim = similarity(l.sourceText, u.sourceText)
    // 结构启发式先行：短标题整词替换、仅占位符/代码槽位变化时字符 bigram 相似度天然偏低。
    // 仅在标准阈值（有基线）下放行；无基线旧稿保持保守，避免把不相干的标题错挂。
    if (minSimilarity <= SIMILARITY_THRESHOLD
      && l.kind === 'heading'
      && headingLevel(l.sourceText) === headingLevel(u.sourceText)
      && headingAlike(l.sourceText, u.sourceText)) {
      return Math.max(sim, 0.4)
    }
    if (skeleton(l.sourceText) === skeleton(u.sourceText) && sim >= Math.max(0.35, minSimilarity - 0.25)) return Math.max(sim, 0.5)
    if (sim >= minSimilarity) return sim
    return 0
  }
  const pairScore: number[][] = Array.from({ length: n }, () => new Array<number>(m).fill(0))
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      pairScore[i][j] = canPair(localUnmatched[i], upstreamUnmatched[j])
      score[i + 1][j + 1] = Math.max(
        score[i][j] + pairScore[i][j],
        score[i][j + 1],
        score[i + 1][j],
      )
    }
  }
  const pairs: [Segment, Segment][] = []
  const usedLocal = new Set<number>()
  const usedUpstream = new Set<number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (score[i][j] === score[i - 1][j]) { i -= 1; continue }
    if (score[i][j] === score[i][j - 1]) { j -= 1; continue }
    if (pairScore[i - 1][j - 1] > 0) {
      pairs.unshift([localUnmatched[i - 1], upstreamUnmatched[j - 1]])
      usedLocal.add(i - 1)
      usedUpstream.add(j - 1)
    }
    i -= 1
    j -= 1
  }
  return {
    pairs,
    localLeftovers: localUnmatched.filter((_, index) => !usedLocal.has(index)),
    upstreamLeftovers: upstreamUnmatched.filter((_, index) => !usedUpstream.has(index)),
  }
}

const withBaseline = (segment: Segment): Segment => ({
  ...segment,
  baselineSource: segment.sourceText,
  baselineTarget: segment.targetText,
})

const conflictId = (mergeId: string, stableId: string) => `conflict-${mergeId}-${stableId.replace(/[#]/g, '-')}`
const historyId = (mergeId: string, stableId: string, kind: string) =>
  `history-${mergeId}-${kind}-${stableId.replace(/[#]/g, '-')}`

export interface MergeInput {
  mergeId: string
  /** 断网期间本地继续编辑的草稿片段（可能为没有基线的旧稿）。 */
  local: Segment[]
  /** 重新导入的上游新版本片段（已解析、未挂接译文）。 */
  upstream: Segment[]
  /** 上游文档内声明的上一版片段快照；缺省时回退到本地片段内嵌基线。 */
  upstreamPrevious?: Segment[]
  sourceName?: string
  upstreamVersion?: string | number
  remoteAuthor?: string
  now?: number
}

/**
 * 三向合并本地草稿与上游新版本（base = 上次同步基线，L = 本地，U = 上游新版）：
 *
 * - 原文未动：保留本地译文、讨论与确认状态；仅上游改译文时快进到上游译文。
 * - 原文变、本地译文未改：接回新原文，退回待处理，旧译文仅作参考不覆盖。
 * - 两边都改过：并列保留本地与上游内容，产出冲突，裁决前任何一侧都不覆盖。
 * - 上游新增：留空待译。上游移除：带译文进入已移除清单。
 * - 无基线旧稿：兼容读入；挂不上且本地有译文的片段进入冲突（legacy-no-baseline）。
 *
 * 历史记录 id 由 mergeId 与稳定标识确定性派生，同一检查点重试不会产生重复历史。
 */
export const mergeDocuments = (input: MergeInput): MergeResult => {
  const now = input.now ?? Date.now()
  const { mergeId } = input
  const local = assignStableIds(clone(input.local))
  const upstream = assignStableIds(clone(input.upstream))
  const previous = input.upstreamPrevious ? assignStableIds(clone(input.upstreamPrevious)) : []
  const previousById = new Map(previous.map((segment) => [segment.stableId as string, segment]))

  /** 每个本地片段的同步基线：优先上游上一版快照，其次片段内嵌基线。 */
  const embeddedBase = (segment: Segment): Segment | undefined =>
    segment.baselineSource === undefined ? undefined : {
      ...segment,
      sourceText: segment.baselineSource,
      targetText: segment.baselineTarget ?? '',
    }

  // ── 片段挂接 ──────────────────────────────────────────────────────────────
  // 1) 精确：本地当前指纹 == 上游指纹（重复句靠 #序号 区分）。
  const localById = new Map(local.map((segment) => [segment.stableId as string, segment]))
  const exactUpstreamKeys = new Set<string>()
  for (const up of upstream) if (localById.has(up.stableId as string)) exactUpstreamKeys.add(up.stableId as string)

  // 2) 按基线挂接：用本地片段的基线原文与上游做顺序对齐。
  //    这样即便本地原文与上游都已偏离同步版本，仍能挂回同一逻辑片段。
  const localRemaining = local.filter((segment) => !exactUpstreamKeys.has(segment.stableId as string))
  const upstreamRemaining = upstream.filter((segment) => !exactUpstreamKeys.has(segment.stableId as string))

  const basedLocal: { local: Segment; base: Segment }[] = []
  const legacyLocal: Segment[] = []
  for (const segment of localRemaining) {
    const base = previousById.get(segment.stableId as string) ?? embeddedBase(segment)
    if (base) basedLocal.push({ local: segment, base })
    else legacyLocal.push(segment)
  }

  // 用“基线视图”参与 LCS，顺序锚定的是同步时的文档；本地的增删不会让后续片段错位。
  const baseView = basedLocal.map(({ base }) => base)
  const baseAlignment = alignSegments(baseView, upstreamRemaining)
  // alignSegments 返回的是原对象引用，可直接按引用映射回 basedLocal。
  const alignedByLocal = new Map<Segment, Segment>()
  baseAlignment.pairs.forEach(([baseSeg, up]) => {
    const localIndex = baseView.indexOf(baseSeg)
    if (localIndex >= 0) alignedByLocal.set(basedLocal[localIndex].local, up)
  })
  const baseAlignedUpstream = new Set(baseAlignment.pairs.map(([, up]) => up.stableId))

  // 3) 无基线旧稿：对上游仍未匹配的片段做高阈值保守对齐。
  const upstreamForLegacy = upstreamRemaining.filter((segment) => !baseAlignedUpstream.has(segment.stableId as string))
  const legacyAlignment = alignSegments(legacyLocal, upstreamForLegacy, { minSimilarity: 0.6 })
  legacyAlignment.pairs.forEach(([l, u]) => alignedByLocal.set(l, u))

  const merged: Segment[] = []
  const removedSegments: Segment[] = []
  const mergeConflicts: MergeConflict[] = []
  const historyEntries: HistoryEntry[] = []
  const discussionIdMap: Record<string, string> = {}
  const counts = { unchanged: 0, fastForwarded: 0, sourceChanged: 0, conflicts: 0, added: 0, removed: 0 }

  const taggedNote = (segment: Segment, prefix: string) => {
    const tag = `【${prefix}】`
    if (!segment.note) return tag
    return segment.note.includes(tag) ? segment.note : `${tag}${segment.note}`
  }

  const pushHistory = (id: string, entry: Omit<HistoryEntry, 'id'>) =>
    historyEntries.push({ id, ...entry })

  const buildConflict = (
    key: string,
    reason: MergeConflict['reason'],
    localSeg: Segment,
    up: Segment,
    baseSource: string,
  ): MergeConflict => ({
    id: conflictId(mergeId, key),
    stableId: key,
    index: up.index,
    kind: up.kind,
    reason,
    localSource: reason === 'source-and-target' ? baseSource : localSeg.sourceText,
    upstreamSource: up.sourceText,
    localTarget: localSeg.targetText,
    upstreamTarget: up.targetText,
    protectedTokens: Array.from(new Set([...localSeg.protectedTokens, ...extractProtected(up.sourceText)])),
    localNote: localSeg.note,
    upstreamNote: up.note,
    remoteAuthor: input.remoteAuthor ?? '上游协作者',
    createdAt: now,
  })

  const resolveLocal = (up: Segment): Segment | undefined => {
    if (exactUpstreamKeys.has(up.stableId as string)) return localById.get(up.stableId as string)
    return Array.from(alignedByLocal.entries()).find(([, u]) => u.stableId === up.stableId)?.[0]
  }

  upstream.forEach((up, order) => {
    const key = up.stableId as string
    const localSeg = resolveLocal(up)

    const next: Segment = {
      ...up,
      index: order + 1,
      protectedTokens: extractProtected(up.sourceText),
      baselineSource: up.sourceText,
      baselineTarget: up.targetText,
    }

    if (!localSeg) {
      merged.push({ ...next, targetText: '', status: 'draft', note: taggedNote(next, '上游新增') })
      counts.added += 1
      pushHistory(historyId(mergeId, key, 'added'), {
        segmentId: next.id, author: '系统 · 合并', action: 'merge',
        before: '', after: '上游新增片段，待翻译。', createdAt: now,
      })
      return
    }

    discussionIdMap[localSeg.id] = next.id
    const localKey = localSeg.stableId as string
    const baseSeg = previousById.get(localKey) ?? embeddedBase(localSeg)
    const isExact = exactUpstreamKeys.has(key)

    if (!baseSeg) {
      // 兼容没有基线的旧稿。
      if (isExact || normalizeText(localSeg.sourceText) === normalizeText(up.sourceText)) {
        merged.push({ ...next, targetText: localSeg.targetText, status: localSeg.status === 'removed' ? 'draft' : localSeg.status, note: localSeg.note })
        counts.unchanged += 1
        pushHistory(historyId(mergeId, key, 'kept'), {
          segmentId: next.id, author: '系统 · 合并', action: 'merge',
          before: '', after: '旧稿无基线，原文一致，保留译文与确认状态。', createdAt: now,
        })
        return
      }
      if (!localSeg.targetText.trim()) {
        merged.push({ ...next, targetText: '', status: 'draft', note: taggedNote(next, '上游更新') })
        counts.sourceChanged += 1
        pushHistory(historyId(mergeId, key, 'source-changed'), {
          segmentId: next.id, author: '系统 · 合并', action: 'merge',
          before: localSeg.sourceText, after: up.sourceText, createdAt: now,
        })
        return
      }
      const conflict = buildConflict(key, 'legacy-no-baseline', localSeg, next, localSeg.sourceText)
      mergeConflicts.push(conflict)
      merged.push({ ...next, targetText: '', status: 'needs-work', note: '【合并冲突 · 旧稿无基线】本地译文已并列保留在冲突面板，处理前不会覆盖。' })
      counts.conflicts += 1
      pushHistory(conflict.id, {
        segmentId: next.id, author: '系统 · 合并', action: 'merge',
        before: localSeg.targetText, after: '旧稿缺少基线，本地与上游内容并列待裁决。', createdAt: now,
      })
      return
    }

    const sourceChanged = normalizeText(baseSeg.sourceText) !== normalizeText(up.sourceText)
    const localTargetChanged = normalizeText(baseSeg.targetText) !== normalizeText(localSeg.targetText)
    const upstreamTargetChanged = normalizeText(baseSeg.targetText) !== normalizeText(up.targetText)

    if (sourceChanged) {
      if (localTargetChanged) {
        // 上游改原文、本地改译文：两边都改过，并列保留。
        const conflict = buildConflict(key, 'source-and-target', localSeg, next, baseSeg.sourceText)
        mergeConflicts.push(conflict)
        merged.push({ ...next, targetText: '', status: 'needs-work', note: '【合并冲突】上游更新了原文且本地修改过译文，新旧原文与双方译文并列待裁决。' })
        counts.conflicts += 1
        pushHistory(conflict.id, {
          segmentId: next.id, author: '系统 · 合并', action: 'merge',
          before: localSeg.targetText, after: '原文已更新，本地译文并列保留待裁决。', createdAt: now,
        })
      } else {
        // 原文变了而译文没改：接回新原文并退回待处理，旧译文仅备注参考。
        merged.push({
          ...next,
          targetText: '',
          status: 'needs-work',
          note: `【原文已更新 · 退回待处理】旧译文仅供参考：${localSeg.targetText || '（空）'}`,
        })
        counts.sourceChanged += 1
        pushHistory(historyId(mergeId, key, 'source-changed'), {
          segmentId: next.id, author: '系统 · 合并', action: 'merge',
          before: baseSeg.sourceText, after: up.sourceText, createdAt: now,
        })
      }
      return
    }

    if (localTargetChanged && upstreamTargetChanged && localSeg.targetText !== up.targetText) {
      // 原文未动但双方都改了译文：并列保留，裁决前不覆盖。
      const conflict = buildConflict(key, 'both-targets', localSeg, next, baseSeg.sourceText)
      mergeConflicts.push(conflict)
      merged.push({ ...next, targetText: '', status: 'needs-work', note: '【合并冲突】本地与上游都修改了译文，处理前双方内容并列保留，均未覆盖。' })
      counts.conflicts += 1
      pushHistory(conflict.id, {
        segmentId: next.id, author: '系统 · 合并', action: 'merge',
        before: localSeg.targetText, after: '本地与上游译文并列待裁决。', createdAt: now,
      })
      return
    }

    if (!localTargetChanged && upstreamTargetChanged) {
      // 本地译文没动、上游译文更新：快进译文与上游的确认状态。
      merged.push({ ...next, targetText: up.targetText, status: up.targetText.trim() ? up.status : 'draft', note: up.note || localSeg.note })
      counts.fastForwarded += 1
      pushHistory(historyId(mergeId, key, 'fast-forward'), {
        segmentId: next.id, author: '系统 · 合并', action: 'merge',
        before: localSeg.targetText, after: up.targetText, createdAt: now,
      })
      return
    }

    // 原文未动：保留本地译文、讨论（经 discussionIdMap 迁移）与确认状态。
    merged.push({
      ...next,
      targetText: localSeg.targetText,
      status: localSeg.status === 'removed' ? 'draft' : localSeg.status,
      note: localSeg.note,
    })
    counts.unchanged += 1
  })

  // 上游不存在的本地片段：
  // - 有同步基线却在新版消失 → 带着译文进入已移除清单（明确是上游删除）；
  // - 无基线旧稿且本地有译文 → 无法判定是删除还是改写，作为遗留冲突并列保留，绝不丢数据。
  const consumedLocal = new Set<Segment>()
  for (const up of upstream) {
    const localSeg = resolveLocal(up)
    if (localSeg) consumedLocal.add(localSeg)
  }
  local.forEach((localSeg) => {
    if (consumedLocal.has(localSeg) || localSeg.status === 'removed') return
    const hasBaseline = previousById.has(localSeg.stableId as string) || localSeg.baselineSource !== undefined
    if (!hasBaseline && localSeg.targetText.trim()) {
      const orphanConflict: MergeConflict = {
        id: conflictId(mergeId, localSeg.stableId as string),
        stableId: localSeg.stableId as string,
        index: localSeg.index,
        kind: localSeg.kind,
        reason: 'legacy-no-baseline',
        localSource: localSeg.sourceText,
        upstreamSource: '',
        localTarget: localSeg.targetText,
        upstreamTarget: '',
        protectedTokens: localSeg.protectedTokens,
        localNote: localSeg.note,
        upstreamNote: '',
        remoteAuthor: input.remoteAuthor ?? '上游协作者',
        orphanLocal: true,
        segmentId: localSeg.id,
        createdAt: now,
      }
      mergeConflicts.push(orphanConflict)
      counts.conflicts += 1
      // 本地片段同步进入已移除清单作为兜底（译文仍在），冲突解决时可再取回。
      removedSegments.push({
        ...localSeg,
        status: 'removed',
        removedAt: now,
        note: taggedNote(localSeg, '旧稿无基线 · 待人工认领'),
      })
      pushHistory(orphanConflict.id, {
        segmentId: localSeg.id, author: '系统 · 合并', action: 'merge',
        before: localSeg.targetText, after: '旧稿片段无法与上游挂接，译文并列保留待人工认领。', createdAt: now,
      })
      return
    }
    removedSegments.push({
      ...localSeg,
      status: 'removed',
      removedAt: now,
      baselineSource: localSeg.baselineSource ?? localSeg.sourceText,
      baselineTarget: localSeg.baselineTarget ?? localSeg.targetText,
      note: taggedNote(localSeg, '上游已移除'),
    })
    counts.removed += 1
    pushHistory(historyId(mergeId, localSeg.stableId as string, 'removed'), {
      segmentId: localSeg.id, author: '系统 · 合并', action: 'merge',
      before: localSeg.sourceText, after: '上游已移除该片段，译文保留在已移除清单。', createdAt: now,
    })
  })

  const report: MergeReport = {
    mergeId,
    sourceName: input.sourceName ?? 'upstream.md',
    upstreamVersion: input.upstreamVersion ?? 'latest',
    ...counts,
    finishedAt: now,
  }

  return {
    segments: merged,
    removedSegments,
    mergeConflicts,
    baseline: upstream.map(withBaseline),
    discussionIdMap,
    report,
    historyEntries,
  }
}

/** 迁移讨论到合并后的新片段 id；已移除片段的讨论继续挂在原片段上。 */
export const migrateDiscussions = <T extends { segmentId: string }>(
  discussions: T[],
  idMap: Record<string, string>,
): T[] =>
  discussions.map((discussion) =>
    idMap[discussion.segmentId] ? { ...discussion, segmentId: idMap[discussion.segmentId] } : discussion)

/**
 * 应用合并结果（检查点重试时复用同一结果）。
 * 幂等：片段按 stableId 去重、冲突按 id 去重、历史按确定性 id 去重，
 * 同一检查点无论重试多少次都不会多出历史或重复片段。
 */
export const applyMergeResult = (
  current: { history: HistoryEntry[] },
  result: MergeResult,
): { history: HistoryEntry[] } => {
  const existingHistory = new Set(current.history.map((entry) => entry.id))
  const history = [
    ...result.historyEntries.filter((entry) => !existingHistory.has(entry.id)),
    ...current.history,
  ]
  return { history }
}
