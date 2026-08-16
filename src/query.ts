const POLITE_PREFIXES = [
  /^请\s*/,
  /^麻烦\s*/,
  /^帮我看看\s*/,
  /^帮我\s*/,
  /^你能\s*/,
  /^可以\s*/,
  /^please\s*/i,
  /^could you\s*/i,
  /^can you\s*/i,
  /^would you\s*/i,
  /^would\s*/i,
]
const POLITE_SUFFIX =
  /\s*(谢谢|多谢|thanks|thank you|please)$/i
const FULL_WIDTH_RANGE = /[\uFF01-\uFF5E]/g
const WHITESPACE = /\s+/g

export function normalizeQuery(input: string | undefined): string {
  if (input === undefined) return ''
  let value = input.normalize('NFC').trim().toLowerCase()
  value = value.replace(FULL_WIDTH_RANGE, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  )
  value = value.replace(/[？？]/g, '?').replace(/[！]/g, '!')
  for (;;) {
    const before = value
    for (const pattern of POLITE_PREFIXES) {
      value = value.replace(pattern, '')
    }
    if (value === before) break
  }
  value = value.replace(POLITE_SUFFIX, '')
  value = value.replace(/一共/g, '')
  value = value.replace(/这张?(?:图片|截图|图像|画面)/g, '图片')
  value = value.replace(
    /(?:图里|图中|图片里|图片上|图上|图片中有|图中有|图片里有|图片上有)/g,
    '图片',
  )
  value = value.replace(/图片的/g, '图片')
  value = value.replace(/\b(?:this|the)\s+(?:screenshots?|images?|pictures?)\b/gi, '图片')
  value = value.replace(/\b(?:screenshots?|images?|pictures?)\b/gi, '图片')
  value = value.replace(/\bbuttons?\b/gi, '按钮')
  value = value.replace(/\bhow many\b/gi, '数量')
  value = value.replace(/(?:多少个|几个|多少)/g, '数量')
  value = value.replace(/数量\s*个/g, '数量')
  value = value.replace(/(\d+)\s*个/g, '$1 ')
  value = value.replace(/[，,、]/g, ' ')
  value = value.replace(/[?!。.]+$/g, '')
  value = value.replace(WHITESPACE, ' ').trim()
  return value
}

export function canonicalQuestionKey(query: string | undefined): string {
  const normalized = normalizeQuery(query)
  return normalized === '' ? '<empty>' : normalized
}
