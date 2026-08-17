export interface Bm25Document {
  id: string
  text: string
}

export interface Bm25Score {
  id: string
  score: number
}

export interface Bm25Options {
  k1?: number
  b?: number
}

/**
 * Lightweight tokenizer: lowercase ascii words plus Chinese character
 * bigrams, so BM25 works without a segmentation dependency.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let word = ''
  const cjk: string[] = []
  const flushWord = (): void => {
    if (word !== '') {
      tokens.push(word)
      word = ''
    }
  }
  const flushCjk = (): void => {
    for (let index = 0; index < cjk.length - 1; index += 1) {
      tokens.push(cjk[index]! + cjk[index + 1]!)
    }
    if (cjk.length === 1) tokens.push(cjk[0]!)
    cjk.length = 0
  }
  for (const character of text.toLowerCase()) {
    if (/[a-z0-9_]/.test(character)) {
      flushCjk()
      word += character
    } else if (/[\u4e00-\u9fff]/.test(character)) {
      flushWord()
      cjk.push(character)
    } else {
      flushWord()
      flushCjk()
    }
  }
  flushWord()
  flushCjk()
  return tokens
}

export function bm25Scores(
  query: string,
  documents: Bm25Document[],
  options: Bm25Options = {},
): Bm25Score[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || documents.length === 0) return []
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75

  const indexed = documents.map((document) => {
    const tokens = tokenize(document.text)
    const frequencies = new Map<string, number>()
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    return { id: document.id, tokens, frequencies, length: tokens.length }
  })
  const averageLength = indexed.reduce((sum, doc) => sum + doc.length, 0) / indexed.length
  const documentFrequency = new Map<string, number>()
  for (const doc of indexed) {
    for (const token of new Set(doc.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }

  const scores: Bm25Score[] = []
  for (const doc of indexed) {
    let score = 0
    for (const token of new Set(queryTokens)) {
      const frequency = doc.frequencies.get(token) ?? 0
      if (frequency === 0) continue
      const df = documentFrequency.get(token) ?? 0
      const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5))
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / averageLength)
      score += ((frequency * (k1 + 1)) / denominator) * idf
    }
    if (score > 0) scores.push({ id: doc.id, score })
  }
  return scores.sort((a, b) =>
    b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
