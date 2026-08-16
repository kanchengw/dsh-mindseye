import { describe, expect, it } from 'vitest'
import { readImageWithMindsEye, readImagesWithMindsEye } from '../src/tool.js'
import { cacheKeyOf, ExactVisionCache, type CacheIdentity } from '../src/cache.js'
import { buildPrompt } from '../src/prompt.js'
import { normalizeQuery } from '../src/query.js'
import type { VisionResult } from '../src/types.js'
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
})

describe('cache key matches tool identity', () => {
  it('uses the same key shape as ExactVisionCache', () => {
    const identity: CacheIdentity = {
      sha256: 'abc',
      query: normalizeQuery('图中有几个按钮'),
      baseUrl: 'https://p/v1',
      model: 'm',
      promptVersion: 'v1',
    }
    expect(cacheKeyOf(identity)).toContain('abc')
    expect(cacheKeyOf(identity)).toContain('图片有数量按钮')
  })
})
