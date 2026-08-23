import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bm25Scores } from './bm25.js'
import type {
  AnalysisFilter,
  SoftMemoryHit,
  SoftMemoryQuery,
  VisualAnalysisRecord,
  VisualEvidenceRecord,
} from './types.js'

export const DEFAULT_ANALYSIS_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface JsonlMemoryStoreOptions {
  dir: string
  maxEntries?: number
}

/**
 * Append-only JSONL memory store with an in-memory index. Evidence is keyed
 * by image sha256 (latest write wins); analyses keep a bounded rolling list.
 */
export class JsonlMemoryStore {
  private readonly dir: string
  private readonly maxEntries: number
  private readonly evidencePath: string
  private readonly analysisPath: string
  private readonly evidence = new Map<string, VisualEvidenceRecord>()
  private analyses: VisualAnalysisRecord[] = []
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: JsonlMemoryStoreOptions) {
    this.dir = options.dir
    this.maxEntries = options.maxEntries ?? 1000
    this.evidencePath = join(this.dir, 'evidence.jsonl')
    this.analysisPath = join(this.dir, 'analysis.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const line of await readLines(this.evidencePath)) {
      const record = parseJsonLine<VisualEvidenceRecord>(line)
      if (record !== undefined && typeof record.sha256 === 'string') {
        this.evidence.set(record.sha256, record)
      }
    }
    for (const line of await readLines(this.analysisPath)) {
      const record = parseJsonLine<VisualAnalysisRecord>(line)
      if (record !== undefined && typeof record.id === 'string') {
        this.analyses.push(record)
      }
    }
    this.evictEvidence()
    this.evictAnalyses()
    await writeJsonLines(this.evidencePath, [...this.evidence.values()])
    await writeJsonLines(this.analysisPath, this.analyses)
  }

  async putEvidence(record: VisualEvidenceRecord): Promise<void> {
    const existing = this.evidence.get(record.sha256)
    const merged = existing === undefined
      ? record
      : { ...existing, ...definedFields(record) }
    if (merged.lastAccessedAt === undefined) merged.lastAccessedAt = Date.now()
    this.evidence.set(record.sha256, merged)
    const shouldCompact = existing !== undefined || this.evictEvidence()
    await this.appendLine(this.evidencePath, merged)
    if (shouldCompact) await this.replaceJsonLines(this.evidencePath, [...this.evidence.values()])
  }

  getEvidence(sha256: string): VisualEvidenceRecord | undefined {
    const record = this.evidence.get(sha256)
    if (record !== undefined) this.touchEvidence(sha256)
    return record === undefined ? undefined : { ...record, lastAccessedAt: Date.now() }
  }

  async searchEvidence(filter: { sha256?: string }): Promise<VisualEvidenceRecord[]> {
    const records = [...this.evidence.values()]
      .filter((record) => filter.sha256 === undefined || record.sha256 === filter.sha256)
    const now = Date.now()
    for (const record of records) {
      this.evidence.set(record.sha256, { ...record, lastAccessedAt: now })
    }
    return records.map((record) => ({ ...record, lastAccessedAt: now }))
  }

  async putAnalysis(record: VisualAnalysisRecord): Promise<void> {
    this.analyses.push(record)
    await this.appendLine(this.analysisPath, record)
    if (this.evictAnalyses()) await this.replaceJsonLines(this.analysisPath, this.analyses)
  }

  async getAnalyses(filter: AnalysisFilter = {}): Promise<VisualAnalysisRecord[]> {
    return this.analyses
      .filter((record) =>
        (filter.evidenceId === undefined || record.evidenceId === filter.evidenceId)
        && (filter.intent === undefined || record.intent === filter.intent)
        && (filter.normalizedQuery === undefined || record.normalizedQuery === filter.normalizedQuery))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async searchSoftMemory(query: SoftMemoryQuery): Promise<SoftMemoryHit[]> {
    const now = query.now ?? Date.now()
    const ttlMs = query.ttlMs ?? DEFAULT_ANALYSIS_TTL_MS
    const latest = new Map<string, VisualAnalysisRecord>()
    for (const record of this.analyses) {
      if (query.evidenceId !== undefined && record.evidenceId !== query.evidenceId) continue
      if (Number.isFinite(ttlMs) && now - record.createdAt > ttlMs) continue
      const key = [
        record.evidenceId,
        record.intent,
        record.normalizedQuery,
        record.provider,
        record.model,
        record.promptVersion,
      ].join('\u0000')
      const current = latest.get(key)
      if (current === undefined || record.createdAt > current.createdAt) latest.set(key, record)
    }
    const documents = [...latest.values()].map((record) => ({
      id: record.id,
      text: `${record.normalizedQuery} ${record.answerText}`,
    }))
    const scores = bm25Scores(query.query, documents)
    const byId = new Map<string, VisualAnalysisRecord>()
    for (const record of latest.values()) byId.set(record.id, record)
    const limit = query.limit ?? 3
    const hits: SoftMemoryHit[] = []
    for (const score of scores.slice(0, limit)) {
      const record = byId.get(score.id)
      if (record === undefined) continue
      this.touchAnalysis(record)
      hits.push({
        record: {
          ...record,
          lastAccessedAt: now,
          accessCount: record.accessCount + 1,
        },
        score: score.score,
      })
    }
    return hits
  }

  async close(): Promise<void> {
    await this.writeQueue
  }

  async stats(): Promise<{
    evidenceCount: number
    analysisCount: number
    evidenceBytes: number
    analysisBytes: number
  }> {
    const [evidenceBytes, analysisBytes] = await Promise.all([
      fileSize(this.evidencePath),
      fileSize(this.analysisPath),
    ])
    return {
      evidenceCount: this.evidence.size,
      analysisCount: this.analyses.length,
      evidenceBytes,
      analysisBytes,
    }
  }

  private evictEvidence(): boolean {
    let evicted = false
    while (this.evidence.size > this.maxEntries) {
      let oldest: VisualEvidenceRecord | undefined
      for (const record of this.evidence.values()) {
        const accessed = record.lastAccessedAt ?? record.createdAt
        const oldestAccessed = oldest === undefined
          ? undefined
          : oldest.lastAccessedAt ?? oldest.createdAt
        if (oldest === undefined || accessed < (oldestAccessed ?? 0)) oldest = record
      }
      if (oldest === undefined) return evicted
      this.evidence.delete(oldest.sha256)
      evicted = true
    }
    return evicted
  }

  private touchEvidence(sha256: string): void {
    const record = this.evidence.get(sha256)
    if (record === undefined) return
    this.evidence.set(sha256, { ...record, lastAccessedAt: Date.now() })
  }

  private evictAnalyses(): boolean {
    let evicted = false
    while (this.analyses.length > this.maxEntries) {
      let oldestIndex = 0
      for (let index = 1; index < this.analyses.length; index += 1) {
        if (this.analyses[index]!.lastAccessedAt < this.analyses[oldestIndex]!.lastAccessedAt) {
          oldestIndex = index
        }
      }
      this.analyses.splice(oldestIndex, 1)
      evicted = true
    }
    return evicted
  }

  private touchAnalysis(record: VisualAnalysisRecord): void {
    const index = this.analyses.findIndex((item) => item.id === record.id)
    if (index < 0) return
    this.analyses[index] = {
      ...this.analyses[index]!,
      lastAccessedAt: Date.now(),
      accessCount: (this.analyses[index]?.accessCount ?? 0) + 1,
    }
  }

  private appendLine(path: string, record: unknown): Promise<void> {
    const run = this.writeQueue.then(() =>
      appendFile(path, `${JSON.stringify(record)}\n`, 'utf8'))
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private replaceJsonLines(path: string, records: unknown[]): Promise<void> {
    const run = this.writeQueue.then(() => writeJsonLines(path, records))
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }
}

async function readLines(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.split(/\r?\n/).filter((line) => line.trim() !== '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function parseJsonLine<T>(line: string): T | undefined {
  try {
    const value = JSON.parse(line) as unknown
    return typeof value === 'object' && value !== null ? value as T : undefined
  } catch {
    return undefined
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function writeJsonLines(path: string, records: unknown[]): Promise<void> {
  const text = records.length === 0
    ? ''
    : records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(path, text, 'utf8')
}

function definedFields(record: VisualEvidenceRecord): Partial<VisualEvidenceRecord> {
  const out: Partial<VisualEvidenceRecord> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}
