export const OVERRIDE_KINDS = ['extract', 'locate']

export const OVERRIDE_LABELS = {
  extract: 'OCR / 结构化提取',
  locate: '空间定位',
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

export function emptyImageRoute() {
  return {
    model: '',
    baseUrl: '',
    apiKeyEnv: '',
    endpoint: '',
    bodyMode: 'json',
    imageField: 'image',
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

function configImageRouteToDraft(route) {
  if (route === undefined || route === null || typeof route !== 'object') {
    return emptyImageRoute()
  }
  return {
    model: typeof route.model === 'string' ? route.model : '',
    baseUrl: typeof route.baseUrl === 'string' ? route.baseUrl : '',
    apiKeyEnv: typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : '',
    endpoint: typeof route.endpoint === 'string' ? route.endpoint : '',
    bodyMode: route.bodyMode === 'multipart' ? 'multipart' : 'json',
    imageField: typeof route.imageField === 'string' ? route.imageField : 'image',
  }
}

export function decodeSettings(section) {
  const value = section && typeof section === 'object' ? section : {}
  const vision = value.vision && typeof value.vision === 'object' ? value.vision : {}
  const fallbacks = Array.isArray(vision.fallbacks) ? vision.fallbacks : []
  const routes = vision.routes && typeof vision.routes === 'object' ? vision.routes : {}
  const imageRoutes = value.image && typeof value.image === 'object' && Array.isArray(value.image.generate)
    ? value.image.generate
    : []
  const imageEditsRoutes = value.image && typeof value.image === 'object' && Array.isArray(value.image.edit)
    ? value.image.edit
    : []
  const understandRoute = Array.isArray(routes.understand)
    ? routes.understand[0]
    : undefined
  const overrides = {}
  for (const kind of OVERRIDE_KINDS) {
    const first = Array.isArray(routes[kind]) ? routes[kind][0] : undefined
    overrides[kind] = configRouteToDraft(first)
  }
  return {
    defaultRoute: configRouteToDraft(understandRoute),
    overrides,
    imagePrimary: configImageRouteToDraft(imageRoutes[0]),
    imageEdits: configImageRouteToDraft(imageEditsRoutes[0]),
    visionFallbacks: fallbacks,
    imageGenerateRest: imageRoutes.slice(1),
    imageEditRest: imageEditsRoutes.slice(1),
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

export function imageRouteIsComplete(route) {
  return (
    trimmed(route.model) !== ''
    && isValidUrl(trimmed(route.baseUrl))
    && trimmed(route.apiKeyEnv) !== ''
  )
}

export function imageRouteValidationError(route) {
  if (trimmed(route.model) === '') return '模型 ID 不能为空'
  if (!isValidUrl(trimmed(route.baseUrl))) return 'API 地址必须是有效的 HTTP(S) URL'
  if (trimmed(route.apiKeyEnv) === '') return 'API Key 不能为空'
  return undefined
}

export function optionalImageRouteValidationError(route) {
  if (
    trimmed(route.model) === ''
    && trimmed(route.baseUrl) === ''
    && trimmed(route.apiKeyEnv) === ''
  ) {
    return undefined
  }
  return imageRouteValidationError(route)
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

export function imageRouteToConfig(route) {
  return {
    model: trimmed(route.model),
    baseUrl: trimmed(route.baseUrl).replace(/\/+$/, ''),
    apiKeyEnv: trimmed(route.apiKeyEnv),
    ...(trimmed(route.endpoint) === '' ? {} : { endpoint: trimmed(route.endpoint) }),
    ...(route.bodyMode === 'multipart' ? { bodyMode: 'multipart' } : {}),
    ...(trimmed(route.imageField) === '' || trimmed(route.imageField) === 'image' ? {} : { imageField: trimmed(route.imageField) }),
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
  const imageRoutes = imageRouteIsComplete(draft.imagePrimary)
    ? [
        imageRouteToConfig(draft.imagePrimary),
      ]
    : []
  const imageEditsRoutes = imageRouteIsComplete(draft.imageEdits)
    ? [imageRouteToConfig(draft.imageEdits)]
    : []
  return {
    vision: { routes, fallbacks: Array.isArray(draft.visionFallbacks) ? draft.visionFallbacks : [] },
    image: {
      generate: [...imageRoutes, ...(Array.isArray(draft.imageGenerateRest) ? draft.imageGenerateRest : [])],
      edit: [...imageEditsRoutes, ...(Array.isArray(draft.imageEditRest) ? draft.imageEditRest : [])],
    },
  }
}

export function updateRoute(route, patch) {
  return { ...route, ...patch }
}
