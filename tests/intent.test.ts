import { describe, expect, it } from 'vitest'
import {
  classifyIntent,
  isVisionIntent,
  resolveRequestIntent,
  resolveRoutes,
  routeKindForIntent,
} from '../src/intent.js'
import type { RoutingConfig } from '../src/types.js'

describe('classifyIntent', () => {
  it('returns explicit intent with full confidence', () => {
    const result = classifyIntent('unrelated text', 'ocr')
    expect(result.intent).toBe('ocr')
    expect(result.confidence).toBe(1)
  })

  it('classifies OCR queries', () => {
    expect(classifyIntent('识别这张图片里的文字').intent).toBe('ocr')
    expect(classifyIntent('transcribe all text').intent).toBe('ocr')
  })

  it('classifies grounding queries', () => {
    expect(classifyIntent('发送按钮在哪里').intent).toBe('grounding')
    expect(classifyIntent('locate the send button').intent).toBe('grounding')
  })

  it('falls back to general for empty or unmatched input', () => {
    expect(classifyIntent(undefined).intent).toBe('general')
    expect(classifyIntent('你好').intent).toBe('general')
  })

  it('keeps the highest scoring rule when multiple match', () => {
    const result = classifyIntent('识别图中按钮的位置和文字')
    expect(result.intent).toBe('grounding')
    expect(result.matchedRules).toContain('ocr')
  })
})

describe('isVisionIntent', () => {
  it('accepts known intents and rejects others', () => {
    expect(isVisionIntent('ocr')).toBe(true)
    expect(isVisionIntent('translation')).toBe(false)
  })
})

describe('resolveRequestIntent', () => {
  it('uses rules when no explicit intent is given', () => {
    expect(resolveRequestIntent('识别图片里的文字').intent).toBe('ocr')
    expect(resolveRequestIntent('图中有几个人').intent).toBe('general')
  })

  it('honors the model hint when rules are not confident', () => {
    expect(resolveRequestIntent('图中有几个人', 'locate').intent).toBe('grounding')
    expect(resolveRequestIntent('描述这张图', 'understand').intent).toBe('visual-qa')
  })

  it('lets confident rules override a conflicting hint', () => {
    const resolved = resolveRequestIntent('识别图片里的文字', 'understand')
    expect(resolved.intent).toBe('ocr')
    expect(resolved.matchedRules).toContain('ocr')
  })
})

describe('resolveRoutes', () => {
  const config: RoutingConfig = {
    routes: {
      extract: [{ model: 'm', baseUrl: 'https://a/v1', apiKeyEnv: 'A' }],
      understand: [{ model: 'm', baseUrl: 'https://b/v1', apiKeyEnv: 'B' }],
    },
    fallbacks: [{ model: 'm', baseUrl: 'https://c/v1', apiKeyEnv: 'C' }],
  }

  it('uses kind routes, then default, then fallback, without duplicates', () => {
    const routes = resolveRoutes(config, 'extract')
    expect(routes.map((route) => route.baseUrl)).toEqual([
      'https://a/v1',
      'https://b/v1',
      'https://c/v1',
    ])
  })

  it('honors an explicit model override', () => {
    const routes = resolveRoutes(config, 'extract', { model: 'm' })
    expect(routes.map((route) => route.baseUrl)).toEqual([
      'https://a/v1',
      'https://b/v1',
      'https://c/v1',
    ])
  })

  it('keeps configured order and dedupes when a slot has multiple models', () => {
    const multi: RoutingConfig = {
      routes: {
        extract: [
          { model: 'm1', baseUrl: 'https://a/v1', apiKeyEnv: 'A' },
          { model: 'm2', baseUrl: 'https://d/v1', apiKeyEnv: 'D' },
        ],
        understand: [{ model: 'm', baseUrl: 'https://b/v1', apiKeyEnv: 'B' }],
      },
      fallbacks: [{ model: 'm', baseUrl: 'https://c/v1', apiKeyEnv: 'C' }],
    }
    const routes = resolveRoutes(multi, 'extract')
    expect(routes.map((route) => route.baseUrl)).toEqual([
      'https://a/v1',
      'https://d/v1',
      'https://b/v1',
      'https://c/v1',
    ])
  })

  it('maps intents to capability route kinds', () => {
    expect(routeKindForIntent('ocr')).toBe('extract')
    expect(routeKindForIntent('grounding')).toBe('locate')
    expect(routeKindForIntent('visual-qa')).toBe('understand')
    expect(routeKindForIntent('chart')).toBe('understand')
  })
})
