import { normalizeEvidence } from '../bridge/evidence-extract.js'
import type { EvidenceKind, VisualEvidence, VisionIntent } from '../types.js'
import type { VisualEvidenceRecord } from './types.js'

/**
 * When stored evidence already covers a pure extraction intent, the result
 * can be answered without another provider call.
 */
export function pureEvidenceAnswer(
  intent: VisionIntent,
  record: VisualEvidenceRecord,
  query?: string,
): { text: string; evidence: VisualEvidence } | undefined {
  if (intent === 'ocr' && record.ocr !== undefined) {
    return { text: record.ocr.fullText, evidence: { ocr: record.ocr } }
  }
  if (intent === 'layout' && record.layout !== undefined) {
    return { text: JSON.stringify(record.layout, null, 2), evidence: { layout: record.layout } }
  }
  if (
    intent === 'color'
    && record.colors !== undefined
    && record.colors.length > 0
    && isWholeImageColorQuery(query)
  ) {
    return { text: formatWholeImageColors(record.colors), evidence: { colors: record.colors } }
  }
  return undefined
}

/**
 * Combined extraction: only when every requested evidence kind is already
 * stored can the answer be served without another provider call.
 */
export function pureExtractEvidenceAnswer(
  extract: EvidenceKind[],
  record: VisualEvidenceRecord,
): { text: string; evidence: VisualEvidence } | undefined {
  const evidence: VisualEvidence = {}
  for (const kind of extract) {
    if (kind === 'ocr' && record.ocr !== undefined) {
      evidence.ocr = record.ocr
    } else if (kind === 'layout' && record.layout !== undefined) {
      evidence.layout = record.layout
    } else if (kind === 'colors' && record.colors !== undefined && record.colors.length > 0) {
      evidence.colors = record.colors
    } else {
      return undefined
    }
  }
  if (Object.keys(evidence).length === 0) return undefined
  return { text: JSON.stringify(evidence, null, 2), evidence }
}

const COLOR_KEYWORDS = /颜色|配色|色板|色系|色调|主色|色彩|palette|colors?/i
const WHOLE_IMAGE_MARKERS = /整体|整张|整图|整幅|全局|全图|整个|所有|全部|overall|whole\s+image|all\s+colors/i
const TARGET_MARKERS = /按钮|标签|桌子|桌上|车里|背景|前景|顶部|底部|左边|右边|上面|下面|区域|衣服|头发|屏幕|导航|标题|button|background/i

export function isWholeImageColorQuery(query: string | undefined): boolean {
  if (query === undefined || query.trim() === '') return false
  return COLOR_KEYWORDS.test(query)
    && WHOLE_IMAGE_MARKERS.test(query)
    && !TARGET_MARKERS.test(query)
}

function formatWholeImageColors(colors: VisualEvidenceRecord['colors']): string {
  const sorted = [...(colors ?? [])].sort((left, right) => (right.share ?? 0) - (left.share ?? 0))
  const parts = sorted.map((color) =>
    color.share === undefined
      ? color.hex
      : `${color.hex}（约 ${Math.round(color.share * 100)}%）`)
  return `整张图颜色（按占比排序）：${parts.join('、')}`
}

export function evidenceToRecord(
  evidence: VisualEvidence,
): Pick<VisualEvidenceRecord, 'ocr' | 'layout' | 'elements' | 'colors'> {
  const normalized = normalizeEvidence(evidence)
  const record: Pick<VisualEvidenceRecord, 'ocr' | 'layout' | 'elements' | 'colors'> = {}
  if (normalized.ocr !== undefined
    && typeof normalized.ocr === 'object'
    && !Array.isArray(normalized.ocr)
    && typeof (normalized.ocr as { fullText?: unknown }).fullText === 'string') {
    record.ocr = normalized.ocr as VisualEvidenceRecord['ocr']
  }
  if (Array.isArray(normalized.layout)) record.layout = normalized.layout as VisualEvidenceRecord['layout']
  if (Array.isArray(normalized.elements)) record.elements = normalized.elements as VisualEvidenceRecord['elements']
  if (Array.isArray(normalized.colors)) record.colors = normalized.colors as VisualEvidenceRecord['colors']
  return record
}

export function evidenceContextOf(record: VisualEvidenceRecord): VisualEvidence {
  return {
    ...(record.ocr !== undefined ? { ocr: record.ocr } : {}),
    ...(record.layout !== undefined ? { layout: record.layout } : {}),
    ...(record.elements !== undefined ? { elements: record.elements } : {}),
    ...(record.colors !== undefined ? { colors: record.colors } : {}),
  }
}
