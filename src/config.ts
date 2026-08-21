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
  vision?: { routes?: Partial<Record<RouteKind, VisionRoute[]>>; fallbacks?: VisionRoute[] }
  image?: {
    generate?: ImageGenerationRoute[]
    edit?: ImageGenerationRoute[]
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
  image: z.object({
    generate: z.array(imageRouteSchema).default([]),
    edit: z.array(imageRouteSchema).default([]),
  }).default({ generate: [], edit: [] }),
})

export function resolveMindsEyeConfig(
  config: MindsEyeConfig | undefined,
): MindsEyeConfig & {
  vision: { routes: Partial<Record<RouteKind, VisionRoute[]>>; fallbacks: VisionRoute[] }
  image: { generate: ImageGenerationRoute[]; edit: ImageGenerationRoute[] }
} {
  return {
    ...(config?.cacheMaxEntries === undefined ? {} : { cacheMaxEntries: config.cacheMaxEntries }),
    ...(config?.maxBatch === undefined ? {} : { maxBatch: config.maxBatch }),
    ...(config?.memoryDir === undefined ? {} : { memoryDir: config.memoryDir }),
    ...(config?.memory === undefined ? {} : { memory: config.memory }),
    ...(config?.userNotice === undefined ? {} : { userNotice: config.userNotice }),
    vision: {
      routes: config?.vision?.routes ?? {},
      fallbacks: config?.vision?.fallbacks ?? [],
    },
    image: {
      generate: config?.image?.generate ?? [],
      edit: config?.image?.edit ?? [],
    },
  }
}
