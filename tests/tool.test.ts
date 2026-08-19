import { describe, expect, it } from 'vitest'
import { readImageWithMindsEye, readImagesWithMindsEye } from '../src/tool.js'
import { cacheKeyOf, ExactVisionCache, type CacheIdentity } from '../src/cache.js'
import { fingerprintBytes } from '../src/evidence.js'
import { buildPrompt } from '../src/prompt.js'
import { normalizeQuery } from '../src/query.js'
import type { VisionResult } from '../src/types.js'
import type { SoftMemoryHit, VisualEvidenceRecord } from '../src/memory/types.js'
import { vi } from 'vitest'

describe('readImageWithMindsEye', () => {
  it('reads, analyzes, caches, and reuses the exact result', async () => {
    const cache = new ExactVisionCache(10, 1000)
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      cache: {
        get: (key: string) => cache.get(key),
        set: (key: string, value: VisionResult) => cache.set(key, value),
      },
      runVision: async () => ({
        analysis: { text: 'answer' },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      }),
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye({ path: '/a.png', query: '图中有几个按钮' }, deps, routes)
    expect(first.result.meta.cache).toBe('miss')
    expect(first.result.answer.text).toBe('answer')
    expect(first.result.meta.usage?.totalTokens).toBe(3)
    expect(first.result.query).toBe('图中有几个按钮')

    const second = await readImageWithMindsEye({ path: '/a.png', query: '图中有几个按钮' }, deps, routes)
    expect(second.fromCache).toBe(true)
    expect(second.result.meta.cache).toBe('hit')
  })

  it('does not reuse the cache for a different query', async () => {
    const cache = new ExactVisionCache(10, 1000)
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      cache: {
        get: (key: string) => cache.get(key),
        set: (key: string, value: VisionResult) => cache.set(key, value),
      },
      runVision: async () => ({ analysis: { text: 'answer' } }),
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye({ path: '/a.png', query: '图中有几个按钮' }, deps, routes)
    const second = await readImageWithMindsEye({ path: '/a.png', query: '按钮在哪里' }, deps, routes)
    expect(first.fromCache).toBe(false)
    expect(second.fromCache).toBe(false)
  })

  it('forwards attachmentId to readImage', async () => {
    const readImage = vi.fn(async () => new TextEncoder().encode('image-bytes'))
    const deps = {
      readImage,
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVision: async () => ({ analysis: { text: 'answer' } }),
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    await readImageWithMindsEye(
      { attachmentId: 'sha256:abc' },
      deps,
      routes,
    )
    expect(readImage).toHaveBeenCalledWith({ path: undefined, attachmentId: 'sha256:abc' })
  })

  it('records a fallback marker when a dedicated route is not configured', async () => {
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVision: async () => ({ analysis: { text: 'answer' } }),
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', query: '识别文字', fallback: 'extract-not-configured' },
      deps,
      routes,
    )
    expect(first.result.meta.fallback).toBe('extract-not-configured')
  })

  it('extracts structured evidence and forwards region to the prompt', async () => {
    let seenRegion: string | undefined
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVision: async () => ({
        analysis: { text: JSON.stringify({
          answer: 'A',
          evidence: { ocr: { fullText: 'hi', language: 'eng' } },
        }) },
      }),
      buildPrompt: (_intent: unknown, options?: { currentRequest?: string; context?: string; region?: string }) => {
        seenRegion = options?.region
        return 'prompt'
      },
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', intent: 'ocr', query: '识别文字', region: '1,2,3,4' },
      deps,
      routes,
    )
    expect(first.result.evidence).toMatchObject({ ocr: { fullText: 'hi' } })
    expect(first.result.answer.text).toBe('hi')
    expect(seenRegion).toBe('1,2,3,4')
  })

  it('requests and parses combined evidence in one call', async () => {
    let seenExtract: unknown
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVision: async () => ({
        analysis: { text: JSON.stringify({
          answer: '海报内容如下',
          evidence: {
            ocr: { fullText: '领取免费资源包' },
            colors: [{ hex: '#e9ebff', share: 0.7 }],
          },
        }) },
      }),
      buildPrompt: (_intent: unknown, options?: { extract?: unknown }) => {
        seenExtract = options?.extract
        return 'combined prompt'
      },
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', intent: 'visual-qa', extract: ['ocr', 'colors'], query: '看文字和颜色' },
      deps,
      routes,
    )
    expect(seenExtract).toEqual(['ocr', 'colors'])
    expect(first.result.answer.text).toBe('海报内容如下')
    expect(first.result.evidence).toEqual({
      ocr: { fullText: '领取免费资源包' },
      colors: [{ hex: '#e9ebff', share: 0.7 }],
    })
  })

  it('reads multiple images in one batch call', async () => {
    const deps = {
      readImage: async ({ attachmentId }: { attachmentId?: string }) =>
        new TextEncoder().encode(`bytes-${attachmentId}`),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVisionBatch: async () => ({
        results: new Map([
          ['sha256:a', 'answer A'],
          ['sha256:b', 'answer B'],
        ]),
        errors: new Map(),
        attempts: [{ provider: 'p', model: 'm', ok: true, latencyMs: 1, images: 2 }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      buildBatchPrompt: () => 'batch prompt',
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImagesWithMindsEye(
      { attachmentIds: ['sha256:a', 'sha256:b'], intent: 'visual-qa' },
      deps,
      routes,
    )
    expect(result.images).toHaveLength(2)
    expect(result.answer.structured).toMatchObject({
      results: { 'sha256:a': { text: 'answer A' }, 'sha256:b': { text: 'answer B' } },
    })
    expect(result.meta.usage?.totalTokens).toBe(2)
  })

  it('extracts per-image evidence from batch results', async () => {
    const deps = {
      readImage: async ({ attachmentId }: { attachmentId?: string }) =>
        new TextEncoder().encode(`bytes-${attachmentId}`),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      runVisionBatch: async () => ({
        results: new Map([
          ['sha256:a', JSON.stringify({
            text: 'answer A',
            evidence: { colors: [{ hex: '#ff0000', share: 0.5 }] },
          })],
        ]),
        errors: new Map(),
        attempts: [{ provider: 'p', model: 'm', ok: true, latencyMs: 1, images: 1 }],
      }),
      buildBatchPrompt: () => 'batch prompt',
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImagesWithMindsEye(
      { attachmentIds: ['sha256:a'], intent: 'color' },
      deps,
      routes,
    )
    const perImage = result.answer.structured as { results: Record<string, { evidence?: unknown }> }
    expect(perImage.results['sha256:a']?.evidence).toEqual({
      colors: [{ hex: '#ff0000', share: 0.5 }],
    })
  })

  it('reuses the batch cache for identical image sets', async () => {
    const cache = new ExactVisionCache(10, Number.POSITIVE_INFINITY)
    const runVisionBatch = vi.fn(async () => ({
      results: new Map([['sha256:a', 'answer A']]),
      errors: new Map(),
      attempts: [{ provider: 'p', model: 'm', ok: true, latencyMs: 1, images: 1 }],
    }))
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      cache: {
        get: (key: string) => cache.get(key),
        set: (key: string, value: VisionResult) => cache.set(key, value),
      },
      runVisionBatch,
      buildBatchPrompt: () => 'batch prompt',
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImagesWithMindsEye(
      { attachmentIds: ['sha256:a'], intent: 'visual-qa', query: '图里有什么' },
      deps,
      routes,
    )
    const second = await readImagesWithMindsEye(
      { attachmentIds: ['sha256:a'], intent: 'visual-qa', query: '图里有什么' },
      deps,
      routes,
    )
    expect(first.meta.cache).toBe('miss')
    expect(second.meta.cache).toBe('hit')
    expect(runVisionBatch).toHaveBeenCalledTimes(1)
  })

  it('serves pure extraction intents from stored evidence without calling the model', async () => {
    const stored: VisualEvidenceRecord = {
      id: 'ev-1',
      sha256: 'sha256:a',
      width: 10,
      height: 20,
      format: 'png',
      ocr: { fullText: 'stored text', language: 'eng' },
      createdAt: 1,
    }
    const runVision = vi.fn()
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => stored,
        putEvidence: vi.fn(),
      },
      runVision,
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', intent: 'ocr', query: '识别文字' },
      deps,
      routes,
    )
    expect(first.result.evidence).toMatchObject({ ocr: { fullText: 'stored text' } })
    expect(first.result.meta.matchedEvidenceIds).toEqual(['ev-1'])
    expect(runVision).not.toHaveBeenCalled()
  })

  it('serves whole-image color questions from stored palette without calling the model', async () => {
    const stored: VisualEvidenceRecord = {
      id: 'ev-1',
      sha256: 'sha256:a',
      width: 10,
      height: 20,
      format: 'png',
      colors: [{ hex: '#ff0000', share: 0.5 }],
      createdAt: 1,
    }
    const runVision = vi.fn()
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => stored,
        putEvidence: vi.fn(),
      },
      runVision,
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImageWithMindsEye(
      { path: '/a.png', intent: 'color', query: '整体主色是什么' },
      deps,
      routes,
    )
    expect(result.result.evidence).toMatchObject({ colors: [{ hex: '#ff0000', share: 0.5 }] })
    expect(result.result.answer.text).toContain('#ff0000')
    expect(result.result.meta.matchedEvidenceIds).toEqual(['ev-1'])
    expect(runVision).not.toHaveBeenCalled()
  })

  it('keeps targeted color questions on the model path', async () => {
    const stored: VisualEvidenceRecord = {
      id: 'ev-1',
      sha256: 'sha256:a',
      width: 10,
      height: 20,
      format: 'png',
      colors: [{ hex: '#ff0000', share: 0.5 }],
      createdAt: 1,
    }
    const runVision = vi.fn(async () => ({ analysis: { text: 'model answer' } }))
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => stored,
        putEvidence: vi.fn(),
      },
      runVision,
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImageWithMindsEye(
      { path: '/a.png', intent: 'color', query: '桌上碗碟的颜色' },
      deps,
      routes,
    )
    expect(runVision).toHaveBeenCalled()
    expect(result.result.answer.text).toBe('model answer')
  })

  it('gates userNotice behind the deps flag', async () => {
    const stored: VisualEvidenceRecord = {
      id: 'ev-1',
      sha256: 'sha256:a',
      width: 10,
      height: 20,
      format: 'png',
      ocr: { fullText: 'stored text' },
      createdAt: 1,
    }
    const depsOn = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: { getEvidence: () => stored, putEvidence: vi.fn() },
      userNotice: true,
      runVision: vi.fn(),
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const depsOff = { ...depsOn, userNotice: false }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const on = await readImageWithMindsEye({ path: '/a.png', intent: 'ocr', query: '识别文字' }, depsOn, routes)
    const off = await readImageWithMindsEye({ path: '/a.png', intent: 'ocr', query: '识别文字' }, depsOff, routes)
    expect(on.result.meta.userNotice).toContain('图片证据')
    expect(off.result.meta.userNotice).toBeUndefined()
  })

  it('injects stored evidence into prompts and stores new evidence', async () => {
    let seenPrompt = ''
    const putEvidence = vi.fn()
    const stored: VisualEvidenceRecord = {
      id: 'ev-1',
      sha256: 'sha256:a',
      width: 10,
      height: 20,
      format: 'png',
      ocr: { fullText: 'stored text' },
      createdAt: 1,
    }
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => stored,
        putEvidence,
      },
      runVision: async ({ prompt }: { prompt: string }) => {
        seenPrompt = prompt
        return {
          analysis: { text: JSON.stringify({
            answer: 'A',
            evidence: { colors: [{ hex: '#ff0000', share: 0.5 }] },
          }) },
        }
      },
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', intent: 'color', query: '有哪些颜色' },
      deps,
      routes,
    )
    expect(seenPrompt).toContain('已存储的图片证据')
    expect(first.result.meta.matchedEvidenceIds).toEqual(['ev-1'])
    expect(putEvidence).toHaveBeenCalled()
  })

  it('serves memory-hit images from storage and batches the rest', async () => {
    const shaA = fingerprintBytes(new TextEncoder().encode('bytes'))
    const shaB = fingerprintBytes(new TextEncoder().encode('other-bytes'))
    const runVisionBatch = vi.fn(async ({ images }: { images: Array<{ id: string }> }) => ({
      results: new Map(images.map((image) => [image.id, JSON.stringify({ text: `ans-${image.id}` })])),
      errors: new Map(),
      attempts: [{ provider: 'p', model: 'm', ok: true, latencyMs: 1, images: images.length }],
    }))
    const stored: VisualEvidenceRecord = {
      id: 'ev-a',
      sha256: shaA,
      width: 10,
      height: 20,
      format: 'png',
      ocr: { fullText: 'stored' },
      createdAt: 1,
    }
    const deps = {
      readImage: async ({ attachmentId }: { attachmentId?: string }) =>
        new TextEncoder().encode(attachmentId === shaA ? 'bytes' : 'other-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: (sha256: string) => (sha256 === shaA ? stored : undefined),
        putEvidence: vi.fn(),
      },
      runVisionBatch,
      buildBatchPrompt: () => 'batch prompt',
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImagesWithMindsEye(
      { attachmentIds: [shaA, shaB], intent: 'ocr', query: '识别文字' },
      deps,
      routes,
    )
    expect(result.meta.matchedEvidenceIds).toEqual(['ev-a'])
    const perImage = result.answer.structured as { results: Record<string, { text: string }> }
    expect(perImage.results[shaA]?.text).toBe('stored')
    expect(perImage.results[shaB]?.text).toBe(`ans-${shaB}`)
    const calledImages = runVisionBatch.mock.calls[0]?.[0]?.images as Array<{ id: string }>
    expect(calledImages.map((image) => image.id)).toEqual([shaB])
  })

  it('serves whole-image color questions from stored palettes in batch', async () => {
    const shaA = fingerprintBytes(new TextEncoder().encode('image-bytes'))
    const stored: VisualEvidenceRecord = {
      id: 'ev-a',
      sha256: shaA,
      width: 10,
      height: 20,
      format: 'png',
      colors: [{ hex: '#ff0000', share: 0.5 }],
      createdAt: 1,
    }
    const runVisionBatch = vi.fn()
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => stored,
        putEvidence: vi.fn(),
      },
      runVisionBatch,
      buildBatchPrompt: () => 'batch prompt',
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const result = await readImagesWithMindsEye(
      { attachmentIds: [shaA], intent: 'color', query: '整张图有哪些颜色' },
      deps,
      routes,
    )
    expect(runVisionBatch).not.toHaveBeenCalled()
    expect(result.meta.matchedEvidenceIds).toEqual(['ev-a'])
    const perImage = result.answer.structured as { results: Record<string, { text: string }> }
    expect(perImage.results[shaA]?.text).toContain('#ff0000')
  })

  it('injects soft memory hits and reports softMemoryHits metadata', async () => {
    let seenPrompt = ''
    const hit: SoftMemoryHit = {
      record: {
        id: 'q1',
        evidenceId: 'sha256:x',
        intent: 'visual-qa',
        normalizedQuery: '图里有什么',
        answerText: '历史答案',
        provider: 'qwen',
        model: 'qwen3.6-flash',
        promptVersion: 'v1',
        source: 'model-inferred',
        createdAt: 1,
        lastAccessedAt: 1,
        accessCount: 1,
        importance: 0.5,
      },
      score: 1.2,
    }
    const deps = {
      readImage: async () => new TextEncoder().encode('image-bytes'),
      probeImage: async () => ({ width: 10, height: 20, format: 'png' }),
      memory: {
        getEvidence: () => undefined,
        putEvidence: vi.fn(),
        searchSoftMemory: async () => [hit],
      },
      runVision: async ({ prompt }: { prompt: string }) => {
        seenPrompt = prompt
        return { analysis: { text: 'answer' } }
      },
      buildPrompt,
      toDataUrl: (bytes: Uint8Array, format: string) => `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`,
    }
    const routes = [{ model: 'm', baseUrl: 'https://p/v1', apiKeyEnv: 'K' }]
    const first = await readImageWithMindsEye(
      { path: '/a.png', query: '图里有什么' },
      deps,
      routes,
    )
    expect(seenPrompt).toContain('历史参考')
    expect(first.result.meta.softMemoryHits).toBe(1)
    expect(first.result.meta.retrievalMs).toBeGreaterThanOrEqual(0)
  })
})

describe('cache key matches tool identity', () => {
  it('uses the same key shape as ExactVisionCache', () => {
    const identity: CacheIdentity = {
      sha256: 'abc',
      query: normalizeQuery('图中有几个按钮'),
      intent: 'visual-qa',
      baseUrl: 'https://p/v1',
      model: 'm',
      promptVersion: 'v1',
    }
    expect(cacheKeyOf(identity)).toContain('abc')
    expect(cacheKeyOf(identity)).toContain('图片有数量按钮')
  })
})
