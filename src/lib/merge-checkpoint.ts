import { applyMergeResult, mergeDocuments, type MergeInput } from './merge'
import type { MergeResult, Segment } from './types'

const CHECKPOINT_KEY = 'sologsb-1003-merge-checkpoint-v1'

export type CheckpointStatus = 'prepared' | 'merged' | 'applied'

/**
 * 合并检查点：输入（本地快照、上游版本、上一版快照）与确定性 mergeId 一并落盘。
 * 合并中途失败后重试，复用同一 mergeId，因此历史 id 不变、不会多出历史或重复片段。
 */
export interface MergeCheckpoint {
  mergeId: string
  sourceName: string
  upstreamVersion: string | number
  createdAt: number
  updatedAt: number
  attempts: number
  status: CheckpointStatus
  input: {
    local: Segment[]
    upstream: Segment[]
    upstreamPrevious?: Segment[]
    remoteAuthor?: string
  }
  result?: MergeResult
  error?: string
}

const storage = (): Storage | undefined => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch { /* private mode / unavailable */ }
  return undefined
}

export const loadCheckpoint = (): MergeCheckpoint | undefined => {
  try {
    const raw = storage()?.getItem(CHECKPOINT_KEY)
    return raw ? JSON.parse(raw) as MergeCheckpoint : undefined
  } catch {
    return undefined
  }
}

export const saveCheckpoint = (checkpoint: MergeCheckpoint) => {
  try {
    storage()?.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint))
  } catch { /* checkpoint best effort */ }
}

export const clearCheckpoint = () => {
  try {
    storage()?.removeItem(CHECKPOINT_KEY)
  } catch { /* ignore */ }
}

const newMergeId = () => `merge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export interface PreparedMerge {
  checkpoint: MergeCheckpoint
  result: MergeResult
}

/**
 * 按检查点执行合并：
 * 1. 先落 prepared 检查点；2. 纯函数计算合并结果并落 merged；
 * 任一步失败都保留检查点，下次用 {@link resumeCheckpoint} 重试。
 * 结果已在检查点中时直接复用，不重复计算。
 */
export const prepareMerge = (input: Omit<MergeInput, 'mergeId'>): PreparedMerge => {
  const existing = loadCheckpoint()
  const now = Date.now()
  const checkpoint: MergeCheckpoint = existing && existing.status !== 'applied'
    ? { ...existing, attempts: existing.attempts + 1, updatedAt: now }
    : {
      mergeId: newMergeId(),
      sourceName: input.sourceName ?? 'upstream.md',
      upstreamVersion: input.upstreamVersion ?? 'latest',
      createdAt: now,
      updatedAt: now,
      attempts: 1,
      status: 'prepared',
      input: {
        local: input.local,
        upstream: input.upstream,
        upstreamPrevious: input.upstreamPrevious,
        remoteAuthor: input.remoteAuthor,
      },
    }
  saveCheckpoint(checkpoint)
  try {
    const result = checkpoint.result ?? mergeDocuments({
      mergeId: checkpoint.mergeId,
      local: checkpoint.input.local,
      upstream: checkpoint.input.upstream,
      upstreamPrevious: checkpoint.input.upstreamPrevious,
      sourceName: checkpoint.sourceName,
      upstreamVersion: checkpoint.upstreamVersion,
      remoteAuthor: checkpoint.input.remoteAuthor,
    })
    saveCheckpoint({ ...checkpoint, status: 'merged', result, updatedAt: Date.now() })
    return { checkpoint, result }
  } catch (error) {
    saveCheckpoint({ ...checkpoint, status: 'prepared', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() })
    throw error
  }
}

/** 重试未完成的检查点；没有检查点时返回 undefined。 */
export const resumeCheckpoint = (): PreparedMerge | undefined => {
  const checkpoint = loadCheckpoint()
  if (!checkpoint || checkpoint.status === 'applied') return undefined
  const bumped: MergeCheckpoint = { ...checkpoint, attempts: checkpoint.attempts + 1, updatedAt: Date.now() }
  saveCheckpoint(bumped)
  try {
    const result = bumped.result ?? mergeDocuments({
      mergeId: bumped.mergeId,
      local: bumped.input.local,
      upstream: bumped.input.upstream,
      upstreamPrevious: bumped.input.upstreamPrevious,
      sourceName: bumped.sourceName,
      upstreamVersion: bumped.upstreamVersion,
      remoteAuthor: bumped.input.remoteAuthor,
    })
    saveCheckpoint({ ...bumped, status: 'merged', result })
    return { checkpoint: { ...bumped, status: 'merged', result }, result }
  } catch (error) {
    saveCheckpoint({ ...bumped, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** 合并结果已成功写入应用状态：标记 applied 并清理检查点。 */
export const completeCheckpoint = () => {
  const checkpoint = loadCheckpoint()
  if (checkpoint) saveCheckpoint({ ...checkpoint, status: 'applied', updatedAt: Date.now() })
  clearCheckpoint()
}

/**
 * 幂等应用：把合并结果写入各集合时全部按稳定 id 去重，
 * 配合 {@link applyMergeResult} 的历史去重，重试不会产生重复片段/冲突/历史。
 */
export const dedupeBy = <T,>(items: T[], keyOf: (item: T) => string): T[] => {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = keyOf(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
