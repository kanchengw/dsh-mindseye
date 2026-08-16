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

export function buildPrompt(intent: VisionIntent, query?: string): string {
  const instruction = INTENT_PROMPTS[intent]
  if (query === undefined || query.trim() === '') return instruction
  return `${instruction}\n\nQuestion: ${query}`
}

export function buildBatchPrompt(intent: VisionIntent, ids: string[], query?: string): string {
  const question = query === undefined || query.trim() === ''
    ? '分别描述每张图。'
    : query.trim()
  const instruction = intent === 'ocr'
    ? '对每张图分别做逐字文字提取，严格按原图顺序。'
    : INTENT_PROMPTS[intent]
  return [
    `以下是 ${ids.length} 张图，每张图前面有“图N（id: ...）”标签。`,
    instruction,
    `必须返回一个 JSON 对象，键为图片 id，值为该图对应的回答字符串（OCR 意图返回转录文本）。不要遗漏任何 id。`,
    `用户问题：${question}`,
  ].join('\n')
}
