export interface VisualEvidenceRecord {
  id: string
  sha256: string
  width: number
  height: number
  format: string
  path?: string
  ocr?: { fullText: string; language?: string }
  layout?: Array<{ region: string; content: string }>
  elements?: Array<{ type: string; label?: string; box?: { x1: number; y1: number; x2: number; y2: number } }>
  colors?: Array<{ hex: string; share?: number }>
  provider?: string
  model?: string
  createdAt: number
  lastAccessedAt?: number
}

export interface VisualAnalysisRecord {
  id: string
  evidenceId: string
  intent: string
  normalizedQuery: string
  region?: string
  provider: string
  model: string
  promptVersion: string
  answerText: string
  source: 'user-verified' | 'model-inferred' | 'tool-result'
  createdAt: number
  lastAccessedAt: number
  accessCount: number
  importance: number
}

export interface AnalysisFilter {
  evidenceId?: string
  intent?: string
  normalizedQuery?: string
}

export interface SoftMemoryQuery {
  query: string
  evidenceId?: string
  limit?: number
  now?: number
  ttlMs?: number
}

export interface SoftMemoryHit {
  record: VisualAnalysisRecord
  score: number
}
