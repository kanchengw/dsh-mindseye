import type { VisionIntent, VisualEvidence } from '../types.js'
import type { EvidenceKind } from '../types.js'

const STRUCTURED_INTENTS = new Set<VisionIntent>(['ocr', 'layout', 'grounding', 'color'])

export interface ImageBounds {
  width: number
  height: number
}

export function structuredEvidenceIntent(intent: VisionIntent): boolean {
  return STRUCTURED_INTENTS.has(intent)
}

export function extractStructured(
  text: string,
  intent: VisionIntent,
  extract?: EvidenceKind[],
  bounds?: ImageBounds,
): { answer: string; evidence: VisualEvidence } | undefined {
  const parsed = tryParseJsonObject(text)
  if (parsed === undefined) return undefined
  if (extract !== undefined && extract.length > 0) {
    if (typeof parsed.answer !== 'string') return undefined
    const evidence = normalizeEvidenceStrict(parsed.evidence, extract, bounds)
    return evidence === undefined ? undefined : { answer: parsed.answer, evidence }
  }
  if (!structuredEvidenceIntent(intent)) return undefined
  if (intent === 'ocr') {
    const normalized = normalizeOcrAnswer(parsed)
    if (normalized !== undefined) return normalized
  }
  if (typeof parsed.answer !== 'string') return undefined
  const evidence = normalizeEvidence(parsed.evidence)
  return evidenceWithinBounds(evidence, bounds) ? { answer: parsed.answer, evidence } : undefined
}

export function parseStructuredValue(
  value: string,
  intent?: VisionIntent,
  extract?: EvidenceKind[],
  bounds?: ImageBounds,
): { text: string; evidence: VisualEvidence } | undefined {
  const parsed = tryParseJsonObject(value)
  if (parsed === undefined) return undefined
  if (extract !== undefined && extract.length > 0) {
    if (typeof parsed.text !== 'string') return undefined
    const evidence = normalizeEvidenceStrict(parsed.evidence, extract, bounds)
    return evidence === undefined ? undefined : { text: parsed.text, evidence }
  }
  if (intent === 'ocr') {
    const normalized = normalizeOcrAnswer(parsed)
    if (normalized !== undefined) {
      return { text: normalized.answer, evidence: normalized.evidence }
    }
  }
  if (typeof parsed.text !== 'string') return undefined
  const evidence = normalizeEvidence(parsed.evidence)
  return evidenceWithinBounds(evidence, bounds) ? { text: parsed.text, evidence } : undefined
}

/**
 * qwen-style OCR models return {"answer": [{"rotate_rect", "text"}]} without
 * the standard evidence envelope. Normalize that shape into our ocr.fullText
 * contract so the result can be persisted and reused.
 */
export function normalizeOcrAnswer(
  parsed: Record<string, unknown>,
): { answer: string; evidence: VisualEvidence } | undefined {
  const evidence = normalizeEvidence(parsed.evidence)
  const ocr = evidence.ocr
  const ocrFullText = isRecord(ocr) && typeof (ocr as Record<string, unknown>).fullText === 'string'
    ? (ocr as Record<string, unknown>).fullText as string
    : undefined
  if (ocrFullText !== undefined) {
    return { answer: ocrFullText, evidence }
  }
  if (!Array.isArray(parsed.answer)) return undefined
  const lines = parsed.answer
    .filter(isRecord)
    .map((item) => (typeof item.text === 'string' ? item.text.trim() : ''))
    .filter((line) => line !== '')
  if (lines.length === 0) return undefined
  const storedFullText = isRecord(ocr) && typeof (ocr as Record<string, unknown>).fullText === 'string'
    ? (ocr as Record<string, unknown>).fullText as string
    : undefined
  const storedLanguage = isRecord(ocr) && typeof (ocr as Record<string, unknown>).language === 'string'
    ? (ocr as Record<string, unknown>).language as string
    : undefined
  const fullText = storedFullText ?? lines.join('\n')
  return {
    answer: fullText,
    evidence: { ocr: { fullText, ...(storedLanguage === undefined ? {} : { language: storedLanguage }) } },
  }
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

function normalizeEvidenceStrict(raw: unknown, requested: EvidenceKind[], bounds?: ImageBounds): VisualEvidence | undefined {
  if (!isRecord(raw)) return undefined
  const source = raw as Record<string, unknown>
  if (requested.includes('ocr')) {
    const ocr = source.ocr
    if (!isRecord(ocr) || typeof ocr.fullText !== 'string' || ocr.fullText.trim() === '') return undefined
  }
  if (requested.includes('layout')) {
    if (!Array.isArray(source.layout) || source.layout.length === 0) return undefined
    if (source.layout.some((item) => !isRecord(item) || typeof item.region !== 'string' || item.region.trim() === '' || typeof item.content !== 'string' || item.content.trim() === '')) return undefined
  }
  if (requested.includes('colors')) {
    if (!Array.isArray(source.colors) || source.colors.length === 0) return undefined
    if (source.colors.some((item) => !isRecord(item) || typeof item.hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(item.hex) || (item.share !== undefined && (typeof item.share !== 'number' || item.share < 0 || item.share > 1)))) return undefined
  }
  const evidence = normalizeEvidence(raw)
  for (const kind of requested) {
    if (kind === 'ocr' && evidence.ocr === undefined) return undefined
    if (kind === 'layout' && evidence.layout === undefined) return undefined
    if (kind === 'colors' && evidence.colors === undefined) return undefined
  }
  const layout = evidence.layout as Array<{ region: string; content: string }> | undefined
  const colors = evidence.colors as Array<{ hex: string; share?: number }> | undefined
  const elements = evidence.elements as Array<{ type: string; box?: { x1: number; y1: number; x2: number; y2: number } }> | undefined
  if (layout?.some((item) => item.region === '' || item.content === '')) return undefined
  if (colors?.some((item) => !/^#[0-9a-f]{6}$/i.test(item.hex) || (item.share !== undefined && (item.share < 0 || item.share > 1)))) return undefined
  if (elements?.some((item) => item.type === '' || (item.box !== undefined && !validBox(item.box, bounds)))) return undefined
  return evidence
}

function evidenceWithinBounds(evidence: VisualEvidence, bounds?: ImageBounds): boolean {
  if (bounds === undefined) return true
  const elements = evidence.elements as Array<{ box?: { x1: number; y1: number; x2: number; y2: number } }> | undefined
  return elements?.every((item) => item.box === undefined || validBox(item.box, bounds)) ?? true
}

function validBox(box: { x1: number; y1: number; x2: number; y2: number }, bounds?: ImageBounds): boolean {
  return [box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)
    && box.x1 <= box.x2 && box.y1 <= box.y2
    && (bounds === undefined
      || (box.x1 >= 0 && box.y1 >= 0 && box.x2 <= bounds.width && box.y2 <= bounds.height))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
