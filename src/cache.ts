import type { VisionResult } from './types.js'

export interface CacheIdentity {
  sha256: string
  query: string
  intent: VisionResult['intent']
  extract?: string[]
  context?: string
  historyContext?: string[]
  region?: string
  baseUrl: string
  model: string
  promptVersion: string
}

interface CacheEntry {
  result: VisionResult
  expiresAt: number
  lastAccessedAt: number
}

export function cacheKeyOf(identity: CacheIdentity): string {
  return JSON.stringify([
    identity.sha256,
    identity.query,
    identity.intent,
    (identity.extract ?? []).join(','),
    identity.context ?? '',
    (identity.historyContext ?? []).join('\n'),
    identity.region ?? '',
    identity.baseUrl,
    identity.model,
    identity.promptVersion,
  ])
}

export class ExactVisionCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  get(key: string, now = Date.now()): VisionResult | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return undefined
    }
    entry.lastAccessedAt = now
    return entry.result
  }

  set(key: string, result: VisionResult, ttlMs = this.defaultTtlMs, now = Date.now()): void {
    this.entries.set(key, {
      result,
      expiresAt: now + ttlMs,
      lastAccessedAt: now,
    })
    this.evict(now)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  private evict(now: number): void {
    if (this.entries.size <= this.maxEntries) return
    const expired: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) expired.push(key)
    }
    for (const key of expired) this.entries.delete(key)
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.lastAccessedAt < oldestAt) {
          oldestAt = entry.lastAccessedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }
}
