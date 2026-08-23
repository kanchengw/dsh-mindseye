import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ImageGenerationRoute, RouteKind, VisionRoute } from './types.js'

export const MINDSEYE_SETTINGS_NAMESPACE = settingsNamespace('mindseye')

export interface MindsEyeConfig {
  cacheMaxEntries?: number
  maxBatch?: number
  memoryDir?: string
  memory?: boolean
  userNotice?: boolean
  /** @deprecated Use vision.routes instead. Kept for settings migration. */
  routes?: Partial<Record<RouteKind, VisionRoute[]>>
  /** @deprecated Use vision.fallbacks instead. Kept for settings migration. */
  fallbacks?: VisionRoute[]
  vision?: { routes?: Partial<Record<RouteKind, VisionRoute[]>>; fallbacks?: VisionRoute[] }
  image?: {
    generate?: ImageGenerationRoute[]
    edit?: ImageGenerationRoute[]
    /** @deprecated Use image.generate instead. Kept for settings migration. */
    routes?: ImageGenerationRoute[]
    /** @deprecated Use image.edit instead. Kept for settings migration. */
    edits?: ImageGenerationRoute[]
  }
  gui?: {
    enabled?: boolean
    browser?: 'auto' | 'chrome' | 'edge'
    restrictHosts?: boolean
    allowedHosts?: string[]
    executablePath?: string
    maxSteps?: number
    timeoutMs?: number
  }
}

const routeSchema = z.object({
  model: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  protocol: z.union(['chat-completions', 'responses'] as const),
  maxTokens: z.number(),
})

const imageRouteSchema = z.object({
  model: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  endpoint: z.string(),
  bodyMode: z.union(['json', 'multipart'] as const),
  imageField: z.string(),
})

export const Config: Schema<MindsEyeConfig> = z.object({
  cacheMaxEntries: z.number().step(1).min(1).max(10_000).default(500),
  maxBatch: z.number().step(1).min(1).default(5),
  memoryDir: z.string(),
  memory: z.boolean().default(true),
  userNotice: z.boolean().default(true),
  vision: z.object({
    routes: z.dict(z.array(routeSchema)).default({}),
    fallbacks: z.array(routeSchema).default([]),
  }).default({ routes: {}, fallbacks: [] }),
  // Keep the former settings names readable so existing profiles can migrate
  // without forcing users to re-enter every provider route.
  routes: z.dict(z.array(routeSchema)).default({}),
  fallbacks: z.array(routeSchema).default([]),
  image: z.object({
    generate: z.array(imageRouteSchema).default([]),
    edit: z.array(imageRouteSchema).default([]),
    routes: z.array(imageRouteSchema).default([]),
    edits: z.array(imageRouteSchema).default([]),
  }).default({ generate: [], edit: [], routes: [], edits: [] }),
  gui: z.object({
    enabled: z.boolean().default(false),
    browser: z.union(['auto', 'chrome', 'edge'] as const).default('auto'),
    restrictHosts: z.boolean().default(false),
    allowedHosts: z.array(z.string()).default([]),
    executablePath: z.string().default(''),
    maxSteps: z.number().step(1).min(1).max(100).default(20),
    timeoutMs: z.number().step(1).min(100).max(120_000).default(30_000),
  }).default({ enabled: false, browser: 'auto', restrictHosts: false, allowedHosts: [], executablePath: '', maxSteps: 20, timeoutMs: 30_000 }),
})

export function resolveMindsEyeConfig(
  config: MindsEyeConfig | undefined,
): MindsEyeConfig & {
  vision: { routes: Partial<Record<RouteKind, VisionRoute[]>>; fallbacks: VisionRoute[] }
  image: { generate: ImageGenerationRoute[]; edit: ImageGenerationRoute[] }
} {
  const legacyVisionRoutes = config?.routes ?? {}
  const legacyVisionFallbacks = config?.fallbacks ?? []
  const legacyImageRoutes = config?.image?.routes ?? []
  const legacyImageEdits = config?.image?.edits ?? []
  const visionRoutes = Object.keys(config?.vision?.routes ?? {}).length > 0
    ? config?.vision?.routes ?? {}
    : legacyVisionRoutes
  const visionFallbacks = (config?.vision?.fallbacks?.length ?? 0) > 0
    ? config?.vision?.fallbacks ?? []
    : legacyVisionFallbacks
  const imageGenerate = (config?.image?.generate?.length ?? 0) > 0
    ? config?.image?.generate ?? []
    : legacyImageRoutes
  const imageEdit = (config?.image?.edit?.length ?? 0) > 0
    ? config?.image?.edit ?? []
    : legacyImageEdits

  return {
    ...(config?.cacheMaxEntries === undefined ? {} : { cacheMaxEntries: config.cacheMaxEntries }),
    ...(config?.maxBatch === undefined ? {} : { maxBatch: config.maxBatch }),
    ...(config?.memoryDir === undefined ? {} : { memoryDir: config.memoryDir }),
    ...(config?.memory === undefined ? {} : { memory: config.memory }),
    ...(config?.userNotice === undefined ? {} : { userNotice: config.userNotice }),
    vision: {
      routes: visionRoutes,
      fallbacks: visionFallbacks,
    },
    image: {
      generate: imageGenerate,
      edit: imageEdit,
    },
    gui: {
      enabled: config?.gui?.enabled ?? false,
      browser: config?.gui?.browser ?? 'auto',
      restrictHosts: config?.gui?.restrictHosts ?? false,
      allowedHosts: config?.gui?.allowedHosts ?? [],
      ...(config?.gui?.executablePath === undefined || config.gui.executablePath === ''
        ? {}
        : { executablePath: config.gui.executablePath }),
      maxSteps: config?.gui?.maxSteps ?? 20,
      timeoutMs: config?.gui?.timeoutMs ?? 30_000,
    },
  }
}
