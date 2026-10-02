import assert from 'node:assert/strict'
import { clearCheckpoint, completeCheckpoint, loadCheckpoint, prepareMerge, resumeCheckpoint } from '../src/lib/merge-checkpoint'
import type { Segment } from '../src/lib/types'

// localStorage 桩
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
}
;(globalThis as Record<string, unknown>).window = { localStorage: new MemoryStorage() }

let passed = 0
const test = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ✓ ${name}`) }

const local: Segment[] = [
  { id: 'l1', index: 1, kind: 'paragraph', sourceText: 'The controller restarts the pod when the configuration changes.', targetText: '配置变化时控制器会重启 Pod。', status: 'confirmed', protectedTokens: [], note: '', baselineSource: 'The controller restarts the pod when the configuration changes.', baselineTarget: '配置变化时控制器会重启 Pod。' },
]
const upstream: Segment[] = [
  { id: 'u1', index: 1, kind: 'paragraph', sourceText: 'The controller restarts the pod when the configuration changes automatically.', targetText: '', status: 'draft', protectedTokens: [], note: '', baselineSource: '', baselineTarget: '' },
]

const input = { local, upstream, sourceName: 'd.md', upstreamVersion: 'v9' }

test('首次合并落检查点，结果可从存储恢复', () => {
  const prepared = prepareMerge(input)
  assert.equal(prepared.result.report.sourceChanged, 1)
  const stored = loadCheckpoint()
  assert.ok(stored)
  assert.equal(stored!.status, 'merged')
  assert.equal(stored!.attempts, 1)
  assert.ok(stored!.result)
})

test('未完成状态下再次 prepareMerge 复用同一 mergeId 且 attempts 递增', () => {
  const firstId = loadCheckpoint()!.mergeId
  const again = prepareMerge(input)
  assert.equal(again.checkpoint.mergeId, firstId)
  assert.equal(again.checkpoint.attempts, 2)
  // 结果完全一致（确定性派生）
  assert.equal(again.result.report.sourceChanged, 1)
})

test('resumeCheckpoint 复用检查点，不产生新 mergeId', () => {
  const id = loadCheckpoint()!.mergeId
  const resumed = resumeCheckpoint()
  assert.ok(resumed)
  assert.equal(resumed!.checkpoint.mergeId, id)
  assert.equal(resumed!.checkpoint.attempts, 3)
})

test('完成后检查点被清理，resumeCheckpoint 返回 undefined', () => {
  completeCheckpoint()
  assert.equal(loadCheckpoint(), undefined)
  assert.equal(resumeCheckpoint(), undefined)
})

test('全新合并产生新的 mergeId', () => {
  clearCheckpoint()
  const a = prepareMerge(input)
  const idA = a.checkpoint.mergeId
  completeCheckpoint()
  const b = prepareMerge(input)
  assert.notEqual(b.checkpoint.mergeId, idA)
  completeCheckpoint()
})

test('检查点中保存的结果重试后历史 id 不变（不多历史）', () => {
  clearCheckpoint()
  const first = prepareMerge(input)
  const idsFirst = first.result.historyEntries.map((h) => h.id)
  const resumed = resumeCheckpoint()!
  const idsRetry = resumed.result.historyEntries.map((h) => h.id)
  assert.deepEqual(idsRetry, idsFirst)
  completeCheckpoint()
})

console.log(`\n${passed} 项检查点测试全部通过 ✅`)
