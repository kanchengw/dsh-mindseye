import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlMemoryStore } from '../src/memory/store.js'
import type { VisualAnalysisRecord, VisualEvidenceRecord } from '../src/memory/types.js'

const dirs: string[] = []

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function tempStore(maxEntries?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'mindseye-memory-'))
  dirs.push(dir)
  const store = new JsonlMemoryStore({ dir, ...(maxEntries === undefined ? {} : { maxEntries }) })
  await store.init()
  return { store, dir }
}

function evidence(sha256: string, overrides: Partial<VisualEvidenceRecord> = {}): VisualEvidenceRecord {
  return {
    id: `ev-${sha256.slice(0, 8)}`,
    sha256,
    width: 10,
    height: 20,
    format: 'png',
    provider: 'qwen',
    model: 'qwen3.6-flash',
    createdAt: 1,
    ...overrides,
  }
}

function analysis(
  id: string,
  evidenceId: string,
  overrides: Partial<VisualAnalysisRecord> = {},
): VisualAnalysisRecord {
  return {
    id,
    evidenceId,
    intent: 'ocr',
    normalizedQuery: '识别文字',
    provider: 'qwen',
    model: 'qwen3.6-flash',
    promptVersion: 'v1',
    answerText: 'answer',
    source: 'model-inferred',
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 1,
    importance: 0.5,
    ...overrides,
  }
}

describe('JsonlMemoryStore', () => {
  it('round-trips evidence and dedupes by sha256', async () => {
    const { store } = await tempStore()
    await store.putEvidence(evidence('sha256:a', { ocr: { fullText: 'first' } }))
    await store.putEvidence(evidence('sha256:a', { ocr: { fullText: 'second' } }))
    expect(store.getEvidence('sha256:a')?.ocr?.fullText).toBe('second')
    await store.close()
  })

  it('merges evidence fields by sha instead of replacing the record', async () => {
    const { store } = await tempStore()
    await store.putEvidence(evidence('sha256:a', { colors: [{ hex: '#ff0000', share: 0.5 }] }))
    await store.putEvidence(evidence('sha256:a', {
      layout: [{ region: '1,2,3,4', content: 'title' }],
      ocr: undefined,
    }))
    const merged = store.getEvidence('sha256:a')
    expect(merged?.colors).toEqual([{ hex: '#ff0000', share: 0.5 }])
    expect(merged?.layout).toEqual([{ region: '1,2,3,4', content: 'title' }])
    await store.putEvidence(evidence('sha256:a', { ocr: { fullText: 'new text' } }))
    expect(store.getEvidence('sha256:a')?.ocr?.fullText).toBe('new text')
    expect(store.getEvidence('sha256:a')?.colors).toEqual([{ hex: '#ff0000', share: 0.5 }])
    await store.close()
  })

  it('filters analyses by evidence id, intent, and query', async () => {
    const { store } = await tempStore()
    await store.putAnalysis(analysis('a1', 'sha256:a', { intent: 'ocr' }))
    await store.putAnalysis(analysis('a2', 'sha256:a', {
      intent: 'visual-qa',
      normalizedQuery: '有什么',
      createdAt: 2,
      lastAccessedAt: 2,
    }))
    await store.putAnalysis(analysis('a3', 'sha256:b', { intent: 'ocr' }))
    expect((await store.getAnalyses({ evidenceId: 'sha256:a' })).map((item) => item.id)).toEqual(['a2', 'a1'])
    expect((await store.getAnalyses({ evidenceId: 'sha256:a', intent: 'ocr' })).map((item) => item.id)).toEqual(['a1'])
    expect((await store.getAnalyses({ normalizedQuery: '有什么' })).map((item) => item.id)).toEqual(['a2'])
    await store.close()
  })

  it('persists records across reopen', async () => {
    const { store, dir } = await tempStore()
    await store.putEvidence(evidence('sha256:a', { colors: [{ hex: '#ff0000', share: 0.5 }] }))
    await store.putAnalysis(analysis('a1', 'sha256:a'))
    await store.close()

    const reopened = new JsonlMemoryStore({ dir })
    await reopened.init()
    expect(reopened.getEvidence('sha256:a')?.colors).toEqual([{ hex: '#ff0000', share: 0.5 }])
    expect((await reopened.getAnalyses({ evidenceId: 'sha256:a' })).map((item) => item.id)).toEqual(['a1'])
    await reopened.close()
  })

  it('evicts least recently accessed analyses beyond the cap', async () => {
    const { store } = await tempStore(2)
    await store.putAnalysis(analysis('old', 'sha256:a', { createdAt: 1, lastAccessedAt: 1 }))
    await store.putAnalysis(analysis('mid', 'sha256:b', { createdAt: 2, lastAccessedAt: 2 }))
    await store.putAnalysis(analysis('new', 'sha256:c', { createdAt: 3, lastAccessedAt: 3 }))
    const ids = (await store.getAnalyses({})).map((item) => item.id)
    expect(ids).not.toContain('old')
    expect(ids).toContain('mid')
    expect(ids).toContain('new')
    await store.close()
  })

  it('evicts least recently accessed evidence beyond the cap', async () => {
    const { store } = await tempStore(2)
    await store.putEvidence(evidence('sha256:a', { createdAt: 1, lastAccessedAt: 1 }))
    await store.putEvidence(evidence('sha256:b', { createdAt: 2, lastAccessedAt: 2 }))
    await store.putEvidence(evidence('sha256:c', { createdAt: 3, lastAccessedAt: 3 }))
    expect(store.getEvidence('sha256:a')).toBeUndefined()
    expect(store.getEvidence('sha256:b')).toBeDefined()
    expect(store.getEvidence('sha256:c')).toBeDefined()
    await store.close()
  })

  it('keeps evidence that was accessed recently', async () => {
    const { store } = await tempStore(2)
    await store.putEvidence(evidence('sha256:a', { createdAt: 1, lastAccessedAt: 1 }))
    await store.putEvidence(evidence('sha256:b', { createdAt: 2, lastAccessedAt: 2 }))
    store.getEvidence('sha256:a')
    await store.putEvidence(evidence('sha256:c', { createdAt: 3, lastAccessedAt: 3 }))
    expect(store.getEvidence('sha256:a')).toBeDefined()
    expect(store.getEvidence('sha256:b')).toBeUndefined()
    await store.close()
  })

  it('compacts evidence jsonl after capacity eviction', async () => {
    const { store, dir } = await tempStore(2)
    await store.putEvidence(evidence('sha256:a', { createdAt: 1, lastAccessedAt: 1 }))
    await store.putEvidence(evidence('sha256:b', { createdAt: 2, lastAccessedAt: 2 }))
    await store.putEvidence(evidence('sha256:c', { createdAt: 3, lastAccessedAt: 3 }))
    await store.close()

    const lines = (await readFile(join(dir, 'evidence.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as VisualEvidenceRecord)
    expect(lines.map((item) => item.sha256).sort()).toEqual(['sha256:b', 'sha256:c'])
    expect(lines).toHaveLength(2)
  })

  it('compacts analysis jsonl after capacity eviction', async () => {
    const { store, dir } = await tempStore(2)
    await store.putAnalysis(analysis('old', 'sha256:a', { createdAt: 1, lastAccessedAt: 1 }))
    await store.putAnalysis(analysis('mid', 'sha256:b', { createdAt: 2, lastAccessedAt: 2 }))
    await store.putAnalysis(analysis('new', 'sha256:c', { createdAt: 3, lastAccessedAt: 3 }))
    await store.close()

    const lines = (await readFile(join(dir, 'analysis.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as VisualAnalysisRecord)
    expect(lines.map((item) => item.id).sort()).toEqual(['mid', 'new'])
    expect(lines).toHaveLength(2)
  })

  it('compacts legacy duplicate records when reopening', async () => {
    const { store, dir } = await tempStore()
    await store.close()
    await writeFile(join(dir, 'evidence.jsonl'), [
      JSON.stringify(evidence('sha256:a', { ocr: { fullText: 'old' } })),
      JSON.stringify(evidence('sha256:a', { ocr: { fullText: 'new' } })),
    ].join('\n') + '\n', 'utf8')

    const reopened = new JsonlMemoryStore({ dir })
    await reopened.init()
    await reopened.close()
    const lines = (await readFile(join(dir, 'evidence.jsonl'), 'utf8'))
      .trim()
      .split(/\r?\n/)
    expect(lines).toHaveLength(1)
    expect(reopened.getEvidence('sha256:a')?.ocr?.fullText).toBe('new')
  })

  it('skips corrupted jsonl lines on load', async () => {
    const { store, dir } = await tempStore()
    await store.close()
    await writeFile(join(dir, 'evidence.jsonl'), '{broken}\n', 'utf8')
    const reopened = new JsonlMemoryStore({ dir })
    await reopened.init()
    expect(reopened.getEvidence('anything')).toBeUndefined()
    await reopened.close()
  })

  it('searches evidence by sha256', async () => {
    const { store } = await tempStore()
    await store.putEvidence(evidence('sha256:a'))
    await store.putEvidence(evidence('sha256:b'))
    expect((await store.searchEvidence({ sha256: 'sha256:a' })).map((item) => item.sha256)).toEqual(['sha256:a'])
    expect((await store.searchEvidence({})).map((item) => item.sha256).sort()).toEqual(['sha256:a', 'sha256:b'])
    await store.close()
  })

  it('retrieves soft memory ranked by relevance with dedupe and ttl', async () => {
    const { store } = await tempStore()
    await store.putAnalysis(analysis('q1', 'sha256:a', {
      normalizedQuery: '识别图片里的文字',
      answerText: '答案是 A',
      createdAt: 100,
      lastAccessedAt: 100,
    }))
    await store.putAnalysis(analysis('q2', 'sha256:a', {
      normalizedQuery: '图片中有几个按钮',
      answerText: '答案是 B',
      createdAt: 200,
      lastAccessedAt: 200,
    }))
    await store.putAnalysis(analysis('q3', 'sha256:b', {
      normalizedQuery: '识别图片里的文字',
      answerText: '别的图',
      createdAt: 300,
      lastAccessedAt: 300,
    }))
    const hits = await store.searchSoftMemory({
      query: '识别图片里的文字',
      evidenceId: 'sha256:a',
      limit: 3,
      now: 10_000,
      ttlMs: 100_000,
    })
    expect(hits[0]?.record.id).toBe('q1')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const expired = await store.searchSoftMemory({
      query: '识别图片里的文字',
      evidenceId: 'sha256:a',
      now: 211,
      ttlMs: 10,
    })
    expect(expired).toEqual([])
    await store.close()
  })

  it('dedupes superseded analyses and touches retrieved records', async () => {
    const { store } = await tempStore()
    await store.putAnalysis(analysis('old', 'sha256:a', {
      normalizedQuery: '有什么',
      answerText: '旧答案',
      createdAt: 100,
      lastAccessedAt: 100,
      accessCount: 1,
    }))
    await store.putAnalysis(analysis('new', 'sha256:a', {
      normalizedQuery: '有什么',
      answerText: '新答案',
      createdAt: 200,
      lastAccessedAt: 200,
      accessCount: 1,
    }))
    const hits = await store.searchSoftMemory({
      query: '有什么',
      evidenceId: 'sha256:a',
      now: 10_000,
      ttlMs: Number.POSITIVE_INFINITY,
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.answerText).toBe('新答案')
    expect(hits[0]?.record.accessCount).toBe(2)
    await store.close()
  })

  it('reports evidence and analysis counts plus file bytes', async () => {
    const { store } = await tempStore()
    await store.putEvidence(evidence('sha256:a'))
    await store.putEvidence(evidence('sha256:b'))
    await store.putAnalysis(analysis('a1', 'sha256:a'))
    const stats = await store.stats()
    expect(stats.evidenceCount).toBe(2)
    expect(stats.analysisCount).toBe(1)
    expect(stats.evidenceBytes).toBeGreaterThan(0)
    expect(stats.analysisBytes).toBeGreaterThan(0)
    await store.close()
  })
})
