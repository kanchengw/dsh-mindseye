export const OVERRIDE_KINDS = ['extract', 'locate']

export const OVERRIDE_LABELS = {
  extract: '文字提取（mindseye_ocr）',
  locate: '空间定位（mindseye_ground）',
}

export function emptyRoute() {
  return {
    model: '',
    baseUrl: '',
    apiKeyEnv: '',
    protocol: 'chat-completions',
    maxTokens: '',
  }
}

function configRouteToDraft(route) {
  if (route === undefined || route === null || typeof route !== 'object') {
    return emptyRoute()
  }
  return {
    model: typeof route.model === 'string' ? route.model : '',
    baseUrl: typeof route.baseUrl === 'string' ? route.baseUrl : '',
    apiKeyEnv: typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : '',
    protocol: route.protocol === 'responses' || route.protocol === 'chat-completions'
      ? route.protocol
      : 'chat-completions',
    maxTokens: route.maxTokens === undefined ? '' : String(route.maxTokens),
  }
}

export function decodeSettings(section) {
  const value = section && typeof section === 'object' ? section : {}
  const fallbacks = Array.isArray(value.fallbacks) ? value.fallbacks : []
  const routes = value.routes && typeof value.routes === 'object' ? value.routes : {}
  const understandRoute = Array.isArray(routes.understand)
    ? routes.understand[0]
    : fallbacks[0]
  const overrides = {}
  for (const kind of OVERRIDE_KINDS) {
    const first = Array.isArray(routes[kind]) ? routes[kind][0] : undefined
    overrides[kind] = configRouteToDraft(first)
  }
  return {
    defaultRoute: configRouteToDraft(understandRoute),
    overrides,
    takeover: value.takeover === true,
  }
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function isValidUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

export function routeIsComplete(route) {
  return (
    trimmed(route.model) !== ''
    && isValidUrl(trimmed(route.baseUrl))
    && trimmed(route.apiKeyEnv) !== ''
    && (route.protocol === 'chat-completions' || route.protocol === 'responses')
  )
}

export function routeValidationError(route) {
  if (route.protocol !== 'chat-completions' && route.protocol !== 'responses') {
    return '请选择协议'
  }
  if (trimmed(route.model) === '') return '模型 ID 不能为空'
  if (!isValidUrl(trimmed(route.baseUrl))) return 'API 地址必须是有效的 HTTP(S) URL'
  if (trimmed(route.apiKeyEnv) === '') return 'API Key 不能为空'
  if (route.maxTokens !== '' && (!Number.isInteger(Number(route.maxTokens)) || Number(route.maxTokens) <= 0)) {
    return 'Max Tokens 必须是正整数'
  }
  return undefined
}

export function optionalRouteValidationError(route) {
  if (
    trimmed(route.model) === ''
    && trimmed(route.baseUrl) === ''
    && trimmed(route.apiKeyEnv) === ''
    && route.maxTokens === ''
  ) {
    return undefined
  }
  return routeValidationError(route)
}

export function routeToConfig(route) {
  const model = trimmed(route.model)
  const baseUrl = trimmed(route.baseUrl).replace(/\/+$/, '')
  const apiKeyEnv = trimmed(route.apiKeyEnv)
  const maxTokens = route.maxTokens === ''
    ? undefined
    : Number(route.maxTokens)
  return {
    model,
    baseUrl,
    apiKeyEnv,
    protocol: route.protocol,
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

export function encodeSettings(draft) {
  const routes = {}
  if (routeIsComplete(draft.defaultRoute)) {
    routes.understand = [routeToConfig(draft.defaultRoute)]
  }
  for (const kind of OVERRIDE_KINDS) {
    const route = draft.overrides[kind]
    if (route !== undefined && routeIsComplete(route)) {
      routes[kind] = [routeToConfig(route)]
    }
  }
  return {
    routes,
    fallbacks: [],
    ...(draft.takeover === true ? { takeover: true } : {}),
  }
}

export function updateRoute(route, patch) {
  return { ...route, ...patch }
}
