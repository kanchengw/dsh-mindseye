import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { RouteKind, VisionRoute } from './types.js'

export const MINDSEYE_SETTINGS_NAMESPACE = settingsNamespace('mindseye')

export interface MindsEyeConfig {
  toolName?: string
  cacheMaxEntries?: number
  cacheTtlMs?: number
  promptVersion?: string
  downscaleMaxPixels?: number
  takeover?: boolean
  pasteToPath?: boolean
  maxBatch?: number
  routes?: Partial<Record<RouteKind, VisionRoute[]>>
  fallbacks?: VisionRoute[]
}

const routeSchema = z.object({
  model: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  protocol: z.union(['chat-completions', 'responses'] as const),
  maxTokens: z.number(),
})

export const Config: Schema<MindsEyeConfig> = z.object({
  toolName: z.string().default('mindseye_read_image'),
  cacheMaxEntries: z.number().default(200),
  cacheTtlMs: z.number().default(3_600_000),
  promptVersion: z.string().default('mindseye-v1'),
  downscaleMaxPixels: z.number().default(4_000_000),
  takeover: z.boolean().default(false),
  pasteToPath: z.boolean().default(true),
  maxBatch: z.number().step(1).min(1).default(5),
  routes: z.dict(z.array(routeSchema)).default({}),
  fallbacks: z.array(routeSchema).default([]),
})

export function resolveMindsEyeConfig(
  config: MindsEyeConfig | undefined,
): Required<Pick<MindsEyeConfig, 'routes' | 'fallbacks'>> & MindsEyeConfig {
  return {
    ...config,
    routes: config?.routes ?? {},
    fallbacks: config?.fallbacks ?? [],
  }
}
