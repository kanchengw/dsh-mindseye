import { z } from 'zod'
import type { VisionIntent, VisionResult } from './types.js'
import { VISION_INTENTS } from './types.js'

export const visionIntentSchema = z.enum(VISION_INTENTS)

export const imageInfoSchema = z.object({
  sha256: z.string(),
  path: z.string().optional(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  format: z.string(),
})

export const ocrEvidenceSchema = z.object({
  fullText: z.string(),
  language: z.string().optional(),
})

export const layoutRegionSchema = z.object({
  region: z.string(),
  content: z.string(),
})

export const elementBoxSchema = z.object({
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
})

export const uiElementSchema = z.object({
  type: z.string(),
  label: z.string().optional(),
  box: elementBoxSchema.optional(),
})

export const colorEntrySchema = z.object({
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  share: z.number().min(0).max(1).optional(),
})

export const visualEvidenceSchema = z.object({
  ocr: ocrEvidenceSchema.optional(),
  layout: z.array(layoutRegionSchema).optional(),
  elements: z.array(uiElementSchema).optional(),
  colors: z.array(colorEntrySchema).optional(),
})

export const visionAnalysisSchema = z.object({
  text: z.string(),
  structured: z.unknown().optional(),
})

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
})

export const providerAttemptSchema = z.object({
  provider: z.string(),
  model: z.string(),
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional(),
  usage: tokenUsageSchema.optional(),
})

export const visionResultSchema = z.object({
  version: z.literal(1),
  intent: visionIntentSchema,
  query: z.string().optional(),
  images: z.array(imageInfoSchema),
  evidence: visualEvidenceSchema,
  answer: visionAnalysisSchema,
  meta: z.object({
    provider: z.string(),
    model: z.string(),
    latencyMs: z.number().nonnegative(),
    attempts: z.array(providerAttemptSchema),
    cache: z.enum(['hit', 'miss']),
    usage: tokenUsageSchema.optional(),
    fallback: z.string().optional(),
    matchedEvidenceIds: z.array(z.string()).optional(),
    softMemoryHits: z.number().int().nonnegative().optional(),
    retrievalMs: z.number().nonnegative().optional(),
    modelCall: z.boolean().optional(),
    source: z.string().optional(),
    userNotice: z.string().optional(),
  }),
})

export function parseVisionResult(value: unknown): VisionResult {
  return visionResultSchema.parse(value) as VisionResult
}

export function isVisionIntent(value: string): value is VisionIntent {
  return visionIntentSchema.safeParse(value).success
}
