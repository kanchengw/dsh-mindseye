import type { VisionRoute } from './types.js'

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function routeLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, '')
  } catch {
    return baseUrl
  }
}

export function routeIdentityKey(
  route: Pick<VisionRoute, 'baseUrl' | 'model' | 'protocol'>,
): string {
  return JSON.stringify([
    normalizeBaseUrl(route.baseUrl),
    route.protocol ?? 'chat-completions',
    route.model,
  ])
}
