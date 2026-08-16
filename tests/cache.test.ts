import { describe, expect, it } from 'vitest'
import { cacheKeyOf, ExactVisionCache, type CacheIdentity } from '../src/cache.js'
import type { VisionResult } from '../src/types.js'

const identity: CacheIdentity = {
  sha256: 'abc',
  query: '图片 按钮 数量',
  baseUrl: 'https://a/v1',
  model: 'm',
  promptVersion: 'v1',
}

function result(provider: string): VisionResult {
  return {
    version: 1,
    intent: 'visual-qa',
    images: [],
    evidence: {},
    answer: { text: provider },
    meta: { provider, model: 'm', latencyMs: 1, attempts: [], cache: 'miss' },
  }
}

describe('cacheKeyOf', () => {
  it('is stable and includes all identity fields', () => {
    expect(cacheKeyOf(identity)).toBe(cacheKeyOf({ ...identity }))
    expect(cacheKeyOf({ ...identity, region: '1,2,3,4' })).not.toBe(cacheKeyOf(identity))
    expect(cacheKeyOf({ ...identity, query: 'other' })).not.toBe(cacheKeyOf(identity))
  })
})

describe('ExactVisionCache', () => {
  it('returns undefined on miss and value on hit', () => {
    const cache = new ExactVisionCache(2, 1000)
    const key = cacheKeyOf(identity)
    expect(cache.get(key)).toBeUndefined()
    cache.set(key, result('a'))
    expect(cache.get(key)?.answer.text).toBe('a')
  })

  it('expires entries after ttl', () => {
    const cache = new ExactVisionCache(2, 10)
    const key = cacheKeyOf(identity)
    cache.set(key, result('a'), 10, 100)
    expect(cache.get(key, 105)).toBeDefined()
    expect(cache.get(key, 111)).toBeUndefined()
  })

  it('evicts least recently used entries beyond max', () => {
    const cache = new ExactVisionCache(2, 1_000_000)
    const first = cacheKeyOf({ ...identity, query: 'q1' })
    const second = cacheKeyOf({ ...identity, query: 'q2' })
    const third = cacheKeyOf({ ...identity, query: 'q3' })
    cache.set(first, result('a'), 1_000_000, 1000)
    cache.set(second, result('b'), 1_000_000, 1001)
    cache.get(first, 1002)
    cache.set(third, result('c'), 1_000_000, 1003)
    expect(cache.size).toBe(2)
    expect(cache.get(first, 1004)).toBeDefined()
    expect(cache.get(second, 1004)).toBeUndefined()
    expect(cache.get(third, 1004)).toBeDefined()
  })
})
