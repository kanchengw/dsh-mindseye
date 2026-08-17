import type { VisionIntent } from './types.js'

const INTENT_PROMPTS: Record<VisionIntent, string> = {
  ocr: 'Transcribe every piece of visible text verbatim, line by line. Preserve layout order. Do not summarize.',
  'visual-qa': 'Look at the image carefully and answer the question based only on visible evidence. Do not invent details.',
  grounding: 'Locate the requested target and report its pixel bounding box as x1,y1,x2,y2 in original image coordinates.',
  layout: 'Describe the layout structure: regions, reading order, visual hierarchy, and relationships between elements.',
  chart: 'Read the chart precisely: title, axes, labels, values, legend, and any highlighted regions or trends.',
  color: 'Report the dominant colors and their approximate share as hex values.',
  'pixel-diff': 'Describe differences between the provided images in pixel terms: regions, colors, dimensions, and severity.',
  general: 'Describe the image in enough detail for a text-only assistant to answer follow-up questions accurately.',
}

const EVIDENCE_INSTRUCTION: Partial<Record<VisionIntent, string>> = {
  ocr: 'Return a JSON object with only the evidence field: {"evidence": {"ocr": {"fullText": "<逐字全文>", "language": "<语言，可选>"}}}. Do not add an answer field.',
  layout: 'Return a JSON object: {"answer": "<你的回答>", "evidence": {"layout": [{"region": "x1,y1,x2,y2", "content": "<区域内容>"}]}}.',
  grounding: 'Return a JSON object: {"answer": "<你的回答>", "evidence": {"elements": [{"type": "<元素类型>", "label": "<标签>", "box": {"x1":0,"y1":0,"x2":0,"y2":0}}]}}.',
  color: 'Return a JSON object: {"answer": "<你的回答>", "evidence": {"colors": [{"hex": "#RRGGBB", "share": 0.5}]}}.',
}

export function buildPrompt(intent: VisionIntent, query?: string, region?: string): string {
  const instruction = INTENT_PROMPTS[intent]
  const parts = [instruction]
  const evidence = EVIDENCE_INSTRUCTION[intent]
  if (evidence !== undefined) parts.push(evidence)
  if (region !== undefined && region.trim() !== '') {
    parts.push(`Focus on the pixel region ${region.trim()} (original image coordinates).`)
  }
  if (query !== undefined && query.trim() !== '') parts.push(`Question: ${query}`)
  return parts.join('\n\n')
}

export function buildBatchPrompt(intent: VisionIntent, ids: string[], query?: string, region?: string): string {
  const question = query === undefined || query.trim() === ''
    ? '分别描述每张图。'
    : query.trim()
  const instruction = intent === 'ocr'
    ? '对每张图分别做逐字文字提取，严格按原图顺序。'
    : INTENT_PROMPTS[intent]
  const evidence = EVIDENCE_INSTRUCTION[intent]
  const parts = [
    `以下是 ${ids.length} 张图，每张图前面有“图N（id: ...）”标签。`,
    instruction,
    `必须返回一个 JSON 对象，键为图片 id，值为对象 {"text": "<该图回答>", "evidence": {...}}；evidence 可选，OCR/布局/定位/颜色请按各自结构返回。不要遗漏任何 id。`,
  ]
  if (evidence !== undefined) parts.push(evidence)
  if (region !== undefined && region.trim() !== '') {
    parts.push(`聚焦像素区域 ${region.trim()}（原始图像坐标）。`)
  }
  parts.push(`用户问题：${question}`)
  return parts.join('\n')
}
