import type { IntentClassification, RouteKind, RoutingConfig, VisionIntent, VisionRoute } from './types.js'
import { VISION_INTENTS } from './types.js'
import { routeIdentityKey } from './route.js'

interface IntentRule {
  intent: VisionIntent
  label: string
  patterns: RegExp[]
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'ocr',
    label: 'ocr',
    patterns: [
      /\bocr\b/i,
      /识别.*文字/i,
      /文字.*识别/i,
      /提取.*文本/i,
      /transcri/i,
      /read.*text/i,
    ],
  },
  {
    intent: 'grounding',
    label: 'grounding',
    patterns: [
      /按钮|button/i,
      /位置|坐标|where|locate|click|ground/i,
    ],
  },
  {
    intent: 'layout',
    label: 'layout',
    patterns: [
      /布局|layout|结构|structure|区域/i,
    ],
  },
  {
    intent: 'chart',
    label: 'chart',
    patterns: [
      /图表|chart|plot|axis|曲线|柱状|折线|饼图/i,
    ],
  },
  {
    intent: 'color',
    label: 'color',
    patterns: [
      /颜色|color|色板|palette|hex/i,
    ],
  },
  {
    intent: 'pixel-diff',
    label: 'pixel-diff',
    patterns: [
      /差异|diff|对比|compare|区别/i,
    ],
  },
]

const ALL_INTENTS = new Set<string>(VISION_INTENTS)

export function isVisionIntent(value: string): value is VisionIntent {
  return ALL_INTENTS.has(value)
}

export function routeKindForIntent(intent: VisionIntent): RouteKind {
  if (intent === 'ocr') return 'extract'
  if (intent === 'grounding') return 'locate'
  return 'understand'
}

export function explicitIntentForKind(kind: RouteKind): VisionIntent {
  if (kind === 'extract') return 'ocr'
  if (kind === 'locate') return 'grounding'
  return 'visual-qa'
}

/**
 * Arbitrate between the model's explicit intent hint and the rule
 * classifier. The rules win when they are confident; otherwise the model's
 * context-aware choice is honored.
 */
export function resolveRequestIntent(
  query: string | undefined,
  explicit?: RouteKind,
): IntentClassification {
  const rule = classifyIntent(query)
  if (explicit === undefined) {
    return rule
  }
  if (rule.confidence >= 0.8 && routeKindForIntent(rule.intent) !== explicit) {
    return rule
  }
  return {
    intent: explicitIntentForKind(explicit),
    matchedRules: [`explicit:${explicit}`],
    confidence: 1,
  }
}

export function classifyIntent(
  query: string | undefined,
  explicit?: VisionIntent,
): IntentClassification {
  if (explicit !== undefined && isVisionIntent(explicit)) {
    return { intent: explicit, matchedRules: [`explicit:${explicit}`], confidence: 1 }
  }
  if (query === undefined || query.trim() === '') {
    return { intent: 'general', matchedRules: [], confidence: 0.5 }
  }

  const scores = new Map<VisionIntent, { score: number; labels: string[] }>()
  for (const rule of INTENT_RULES) {
    let matches = 0
    for (const pattern of rule.patterns) {
      if (pattern.test(query)) matches += 1
    }
    if (matches > 0) {
      const current = scores.get(rule.intent)
      scores.set(rule.intent, {
        score: (current?.score ?? 0) + matches,
        labels: [...(current?.labels ?? []), rule.label],
      })
    }
  }

  let best: VisionIntent = 'general'
  let bestScore = 0
  const labels: string[] = []
  let total = 0
  for (const [intent, entry] of scores) {
    total += entry.score
    labels.push(...entry.labels)
    if (entry.score > bestScore) {
      best = intent
      bestScore = entry.score
    }
  }
  if (bestScore === 0) {
    return { intent: 'general', matchedRules: [], confidence: 0.5 }
  }
  return {
    intent: best,
    matchedRules: labels,
    confidence: Math.min(0.99, 0.5 + bestScore / (total * 2)),
  }
}

export function resolveRoutes(
  config: RoutingConfig,
  kind: RouteKind,
  explicit?: { model?: string },
): VisionRoute[] {
  const kindRoutes = config.routes[kind]
  const understandRoutes = kind === 'understand' ? [] : config.routes.understand
  const fallbacks = config.fallbacks ?? []
  let routes = [...(kindRoutes ?? []), ...(understandRoutes ?? []), ...fallbacks]
  if (explicit?.model !== undefined) {
    const matched = routes.filter((route) => route.model === explicit.model)
    if (matched.length > 0) routes = matched
  }
  return dedupeRoutes(routes)
}

function dedupeRoutes(routes: VisionRoute[]): VisionRoute[] {
  const seen = new Set<string>()
  const result: VisionRoute[] = []
  for (const route of routes) {
    const key = routeIdentityKey(route)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(route)
  }
  return result
}
