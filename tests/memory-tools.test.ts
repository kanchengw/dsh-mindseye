import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryTools, diffEvidence } from '../src/memory/tools.js'
import { JsonlMemoryStore } from '../src/memory/store.js'
import type { VisualAnalysisRecord, VisualEvidenceRecord } from '../src/memory/types.js'

const dirs: string[] = []
const fakeExec = {} as never

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

async function tempStore(): Promise<JsonlMemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'mindseye-tools-'))
  dirs.push(dir)
  const store = new JsonlMemoryStore({ dir })
  await store.init()
  return store
}

function evidence(sha256: string, overrides: Partial<VisualEvidenceRecord> = {}): VisualEvidenceRecord {
  return {
    id: `ev-${sha256.slice(0, 8)}`,
    sha256,
    width: 10,
    height: 20,
    format: 'png',
    createdAt: 1,
    ...overrides,
  }
}

function analysis(id: string, evidenceId: string): VisualAnalysisRecord {
  const now = Date.now()
  return {
    id,
    evidenceId,
    intent: 'visual-qa',
    normalizedQuery: '图里有什么',
    provider: 'qwen',
    model: 'qwen3.6-flash',
    promptVersion: 'v1',
    answerText: '答案',
    source: 'model-inferred',
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    importance: 0.5,
  }
}

describe('memory tools', () => {
  it('puts and gets evidence with field merge', async () => {
    const store = await tempStore()
    const tools = createMemoryTools(store)
    const put = tools[0]!
    const get = tools[1]!
    await put.execute({ sha256: 'sha256:a', record: { ocr: { fullText: 'hi' } } }, fakeExec)
    await put.execute({
      sha256: 'sha256:a',
      record: { colors: [{ hex: '#ff0000', share: 0.5 }] },
    }, fakeExec)
    const result = await get.execute({ sha256: 'sha256:a' }, fakeExec) as {
      found: boolean
      record: unknown
    }
    expect(result.found).toBe(true)
    expect(result.record).toMatchObject({
      ocr: { fullText: 'hi' },
      colors: [{ hex: '#ff0000', share: 0.5 }],
    })
    await store.close()
  })

  it('reports missing records as found false with null record', async () => {
    const store = await tempStore()
    const get = createMemoryTools(store)[1]!
    const result = await get.execute({ sha256: 'sha256:missing' }, fakeExec) as {
      found: boolean
      record: unknown
    }
    expect(result).toEqual({ found: false, record: null })
    await store.close()
  })

  it('searches evidence and soft memory', async () => {
    const store = await tempStore()
    await store.putEvidence(evidence('sha256:a', { ocr: { fullText: 'text' } }))
    await store.putAnalysis(analysis('a1', 'sha256:a'))
    const search = createMemoryTools(store)[2]!
    const result = await search.execute({
      sha256: 'sha256:a',
      query: '图里有什么',
    }, fakeExec) as {
      evidence: VisualEvidenceRecord[]
      softMemory: Array<{ record: VisualAnalysisRecord }>
    }
    expect(result.evidence).toHaveLength(1)
    expect(result.softMemory[0]?.record.answerText).toBe('答案')
    await store.close()
  })

  it('diffs evidence fields between two images', async () => {
    const store = await tempStore()
    await store.putEvidence(evidence('sha256:a', { colors: [{ hex: '#ff0000', share: 0.5 }] }))
    await store.putEvidence(evidence('sha256:b', { colors: [{ hex: '#0000ff', share: 0.5 }] }))
    const diff = createMemoryTools(store)[3]!
    const result = await diff.execute({ fromSha256: 'sha256:a', toSha256: 'sha256:b' }, fakeExec) as {
      changed: boolean
      fields: Record<string, { from: unknown; to: unknown }>
    }
    expect(result.changed).toBe(true)
    expect(result.fields.colors).toEqual({
      from: [{ hex: '#ff0000', share: 0.5 }],
      to: [{ hex: '#0000ff', share: 0.5 }],
    })
    const same = await diff.execute({ fromSha256: 'sha256:a', toSha256: 'sha256:a' }, fakeExec) as {
      changed: boolean
      fields: Record<string, { from: unknown; to: unknown }>
    }
    expect(same).toEqual({ changed: false, fields: {} })
    await store.close()
  })
})

describe('diffEvidence', () => {
  it('handles missing records as null', () => {
    const result = diffEvidence(null, evidence('sha256:a', { ocr: { fullText: 'x' } }))
    expect(result.changed).toBe(true)
    expect(result.fields.ocr).toEqual({ from: null, to: { fullText: 'x' } })
  })
})
