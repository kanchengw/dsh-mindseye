export const VISION_INTENTS = [
  'ocr',
  'visual-qa',
  'grounding',
  'layout',
  'chart',
  'color',
  'pixel-diff',
  'general',
] as const

export type VisionIntent = typeof VISION_INTENTS[number]

export const ROUTE_KINDS = ['understand', 'extract', 'locate'] as const

export type RouteKind = typeof ROUTE_KINDS[number]

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface VisionRoute {
  model: string
  baseUrl: string
  apiKeyEnv: string
  protocol?: 'chat-completions' | 'responses'
  maxTokens?: number
}

export interface RoutingConfig {
  routes: Partial<Record<RouteKind, VisionRoute[]>>
  fallbacks?: VisionRoute[]
}

export interface ImageGenerationRoute {
  model: string
  baseUrl: string
  apiKeyEnv: string
}

export interface ImageGenerationSpec {
  prompt: string
  size: string
  n: number
  requestVersion: string
}

export type GeneratedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface GeneratedImage {
  data: Uint8Array
  mediaType: GeneratedImageMediaType
}

export interface ImageGenerationAttempt {
  provider: string
  model: string
  ok: boolean
  latencyMs: number
  error?: string
}

export interface ImageInfo {
  sha256: string
  path?: string
  width: number
  height: number
  format: string
}

export interface OcrEvidence {
  fullText: string
  language?: string
}

export interface LayoutRegion {
  region: string
  content: string
}

export interface ElementBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface UiElement {
  type: string
  label?: string
  box?: ElementBox
}

export interface ColorEntry {
  hex: string
  share?: number
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type VisualEvidence = Record<string, JsonValue>

export type ProviderAttempt = {
  provider: string
  model: string
  ok: boolean
  latencyMs: number
  error: string
  usage?: TokenUsage
} & Record<string, JsonValue>

export interface VisionAnalysis {
  text: string
  structured?: JsonValue
}

export interface VisionResult {
  version: 1
  intent: VisionIntent
  query?: string
  images: ImageInfo[]
  evidence: VisualEvidence
  answer: VisionAnalysis
  meta: {
    provider: string
    model: string
    latencyMs: number
    attempts: ProviderAttempt[]
    cache: 'hit' | 'miss'
    usage?: TokenUsage
    fallback?: string
    matchedEvidenceIds?: string[]
    softMemoryHits?: number
    retrievalMs?: number
    modelCall?: boolean
    source?: string
    userNotice?: string
  }
}

export interface VisionReadOptions {
  path?: string
  attachmentId?: string
  intent?: VisionIntent
  query?: string
  region?: string
  model?: string
  fallback?: string
}

export interface ResolvedVisionDeps {
  readImage: (path: string) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<Pick<ImageInfo, 'width' | 'height' | 'format'>>
  runVision: (options: {
    dataUrl: string
    prompt: string
    route: VisionRoute
    signal?: AbortSignal
  }) => Promise<{ analysis: VisionAnalysis; usage?: TokenUsage }>
}
