import { describe, expect, it } from 'vitest'
import { MetricsCollector, type MetricEvent } from '../src/observability/metrics.js'

function event(overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    intent: 'visual-qa',
    source: 'model',
    cache: 'miss',
    evidenceHit: false,
    softMemoryHits: 0,
    retrievalMs: 0,
    latencyMs: 100,
    modelCall: true,
    at: 1,
    ...overrides,
  }
}

describe('MetricsCollector', () => {
  it('summarizes source distribution and averages', () => {
    const metrics = new MetricsCollector()
    metrics.record(event({ source: 'model', latencyMs: 100 }))
    metrics.record(event({ source: 'evidence', evidenceHit: true, modelCall: false, latencyMs: 0 }))
    metrics.record(event({ source: 'soft-memory', softMemoryHits: 2, retrievalMs: 5, latencyMs: 300 }))
    const summary = metrics.summary()
    expect(summary.total).toBe(3)
    expect(summary.modelCalls).toBe(2)
    expect(summary.cacheHits).toBe(0)
    expect(summary.evidenceHits).toBe(1)
    expect(summary.softMemoryInjects).toBe(1)
    expect(summary.bySource).toEqual({ model: 1, evidence: 1, 'soft-memory': 1 })
    expect(summary.avgLatencyMs).toBeCloseTo(133.33, 1)
    expect(summary.avgRetrievalMs).toBeCloseTo(1.67, 1)
  })

  it('caps the event log and returns recent events', () => {
    const metrics = new MetricsCollector(3)
    metrics.record(event({ at: 1 }))
    metrics.record(event({ at: 2 }))
    metrics.record(event({ at: 3 }))
    metrics.record(event({ at: 4 }))
    expect(metrics.recent(10).map((item) => item.at)).toEqual([2, 3, 4])
    expect(metrics.summary().total).toBe(3)
  })
})
