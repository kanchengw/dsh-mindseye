import { describe, expect, it } from 'vitest'
import { resolveRoutes, routeKindForIntent } from '../src/routes.js'
import type { RoutingConfig } from '../src/types.js'

describe('routeKindForIntent', () => {
  it('maps tool-fixed intents to route families', () => {
    expect(routeKindForIntent('ocr')).toBe('extract')
    expect(routeKindForIntent('grounding')).toBe('locate')
    expect(routeKindForIntent('visual-qa')).toBe('understand')
    expect(routeKindForIntent('chart')).toBe('understand')
    expect(routeKindForIntent('color')).toBe('understand')
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
})
