import type { RouteKind, RoutingConfig, VisionIntent, VisionRoute } from './types.js'
import { routeIdentityKey } from './route.js'

/**
 * Map a tool-fixed intent to the route family it draws its model chain from.
 * Tools choose the intent at registration time; the model picks the tool, so
 * no runtime intent classification is involved.
 */
export function routeKindForIntent(intent: VisionIntent): RouteKind {
  if (intent === 'ocr') return 'extract'
  if (intent === 'grounding') return 'locate'
  return 'understand'
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
