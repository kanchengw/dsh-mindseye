import type { VisionIntent, VisualEvidence } from '../types.js'

const STRUCTURED_INTENTS = new Set<VisionIntent>(['ocr', 'layout', 'grounding', 'color'])

export function structuredEvidenceIntent(intent: VisionIntent): boolean {
  return STRUCTURED_INTENTS.has(intent)
}

export function extractStructured(
  text: string,
  intent: VisionIntent,
): { answer: string; evidence: VisualEvidence } | undefined {
  if (!structuredEvidenceIntent(intent)) return undefined
  const parsed = tryParseJsonObject(text)
  if (parsed === undefined || typeof parsed.answer !== 'string') return undefined
  return { answer: parsed.answer, evidence: normalizeEvidence(parsed.evidence) }
}

export function parseStructuredValue(
  value: string,
): { text: string; evidence: VisualEvidence } | undefined {
  const parsed = tryParseJsonObject(value)
  if (parsed === undefined || typeof parsed.text !== 'string') return undefined
  return { text: parsed.text, evidence: normalizeEvidence(parsed.evidence) }
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

export function normalizeEvidence(raw: unknown): VisualEvidence {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const evidence: VisualEvidence = {}
  if (isRecord(record.ocr) && typeof record.ocr.fullText === 'string') {
    evidence.ocr = {
      fullText: record.ocr.fullText,
      ...(typeof record.ocr.language === 'string' ? { language: record.ocr.language } : {}),
    }
  }
  if (Array.isArray(record.layout)) {
    evidence.layout = record.layout
      .filter(isRecord)
      .map((region) => ({
        region: typeof region.region === 'string' ? region.region : '',
        content: typeof region.content === 'string' ? region.content : '',
      }))
  }
  if (Array.isArray(record.elements)) {
    evidence.elements = record.elements
      .filter(isRecord)
      .map((element) => ({
        type: typeof element.type === 'string' ? element.type : 'unknown',
        ...(typeof element.label === 'string' ? { label: element.label } : {}),
        ...(isRecord(element.box)
          ? { box: {
              x1: toNumber(element.box.x1),
              y1: toNumber(element.box.y1),
              x2: toNumber(element.box.x2),
              y2: toNumber(element.box.y2),
            } }
          : {}),
      }))
  }
  if (Array.isArray(record.colors)) {
    evidence.colors = record.colors
      .filter(isRecord)
      .map((color) => ({
        hex: typeof color.hex === 'string' ? color.hex : '#000000',
        ...(typeof color.share === 'number' ? { share: color.share } : {}),
      }))
  }
  return evidence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
