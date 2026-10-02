import { http, HttpResponse } from 'msw'
import { analyzeDocument } from '@/lib/markdown'
import { mergeIntoState, type MergeCheckpoint, type MergeState } from '@/lib/merge'
import { seedConflicts, seedDocument, seedHistory } from '@/lib/seed'
import type { GlossaryTerm, Segment } from '@/lib/types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const handlers = [
  http.get('/api/document', () => HttpResponse.json(clone(seedDocument))),
  http.get('/api/history', () => HttpResponse.json(clone(seedHistory))),
  http.get('/api/conflicts', () => HttpResponse.json(clone(seedConflicts))),
  http.post('/api/check', async ({ request }) => {
    const body = await request.json() as { segments: Segment[]; glossary: GlossaryTerm[] }
    await new Promise((resolve) => setTimeout(resolve, 320))
    return HttpResponse.json({ checkedAt: Date.now(), issues: analyzeDocument(body.segments, body.glossary) })
  }),
  http.post('/api/draft', async ({ request }) => {
    const body = await request.json() as { documentId: string; segments: Segment[]; discussions: unknown[] }
    await new Promise((resolve) => setTimeout(resolve, 180))
    return HttpResponse.json({ saved: true, documentId: body.documentId, segmentCount: body.segments.length, savedAt: Date.now() })
  }),
  http.post('/api/review', async ({ request }) => {
    const body = await request.json() as { action: string; segmentIds: string[]; reason?: string }
    await new Promise((resolve) => setTimeout(resolve, 280))
    return HttpResponse.json({ accepted: true, ...body, reviewedAt: Date.now() })
  }),
  // 断网恢复后的合并接口：检查点先于提交落盘；演练开关会在提交前制造一次失败。
  http.post('/api/merge', async ({ request }) => {
    const body = await request.json() as { checkpoint: MergeCheckpoint; before: MergeState }
    const { checkpoint, before } = body
    await new Promise((resolve) => setTimeout(resolve, 420))
    if (checkpoint.simulateFailure && checkpoint.attempt === 1) {
      return HttpResponse.json({ error: 'simulated-network-reset', message: '合并提交中断：检查点已保留，可重试。' }, { status: 503 })
    }
    const mergedAt = Date.now()
    const result = mergeIntoState(clone(before), clone(checkpoint.upstream), {
      runId: checkpoint.runId,
      sourceFileName: checkpoint.sourceFileName,
      mergedAt,
    })
    return HttpResponse.json({ ...result, committedAt: mergedAt })
  }),
]
