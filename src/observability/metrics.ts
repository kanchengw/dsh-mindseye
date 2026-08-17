export interface MetricEvent {
  intent: string
  source: string
  cache: 'hit' | 'miss'
  evidenceHit: boolean
  softMemoryHits: number
  retrievalMs: number
  latencyMs: number
  modelCall: boolean
  at: number
}

export interface MetricsSummary {
  total: number
  modelCalls: number
  cacheHits: number
  evidenceHits: number
  softMemoryInjects: number
  bySource: Record<string, number>
  avgLatencyMs: number
  avgRetrievalMs: number
}

export class MetricsCollector {
  private readonly events: MetricEvent[] = []

  constructor(private readonly cap = 1000) {}

  record(event: MetricEvent): void {
    this.events.push(event)
    if (this.events.length > this.cap) this.events.shift()
  }

  recent(limit = 50): MetricEvent[] {
    return this.events.slice(-limit)
  }

  summary(): MetricsSummary {
    let modelCalls = 0
    let cacheHits = 0
    let evidenceHits = 0
    let softMemoryInjects = 0
    let latencySum = 0
    let retrievalSum = 0
    const bySource: Record<string, number> = {}
    for (const event of this.events) {
      if (event.modelCall) modelCalls += 1
      if (event.cache === 'hit') cacheHits += 1
      if (event.evidenceHit) evidenceHits += 1
      if (event.softMemoryHits > 0) softMemoryInjects += 1
      latencySum += event.latencyMs
      retrievalSum += event.retrievalMs
      bySource[event.source] = (bySource[event.source] ?? 0) + 1
    }
    const total = this.events.length
    return {
      total,
      modelCalls,
      cacheHits,
      evidenceHits,
      softMemoryInjects,
      bySource,
      avgLatencyMs: total === 0 ? 0 : latencySum / total,
      avgRetrievalMs: total === 0 ? 0 : retrievalSum / total,
    }
  }
}
