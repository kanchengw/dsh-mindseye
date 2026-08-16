import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ExactVisionCache, cacheKeyOf, type CacheIdentity } from './cache.js'
import { Config, MINDSEYE_SETTINGS_NAMESPACE, type MindsEyeConfig } from './config.js'
import { resolveApiKeyValue } from './credentials.js'
import { fingerprintBytes } from './evidence.js'
import { resolveRequestIntent, resolveRoutes, routeKindForIntent } from './intent.js'
import { normalizeQuery } from './query.js'
import { buildBatchPrompt, buildPrompt } from './prompt.js'
import { runProviderChain, runVisionBatchChain } from './providers.js'
import { registerHistorySanitizer, runTakeover } from './bridge/takeover.js'
import { registerPasteRoute } from './bridge/paste.js'
import type { ImageAttachmentLike } from './bridge/sanitize.js'
import { normalizeBaseUrl } from './route.js'
import { readImageWithMindsEye, readImagesWithMindsEye } from './tool.js'
import { probeDimensions } from './bridge/image-meta.js'

export { Config, MINDSEYE_SETTINGS_NAMESPACE }
export type { MindsEyeConfig }

export const name = 'mindseye'
export const inject = ['tools']

export async function apply(ctx: Context, config: MindsEyeConfig = {}): Promise<void> {
  let currentConfig: MindsEyeConfig = config
  let settingsWritable = true
  let credentials: CredentialProvider | undefined
  let persistSettings: ((section: { routes: unknown; fallbacks: unknown }) => Promise<void>) | undefined
  let imageRefs = new Map<string, ImageAttachmentLike>()
  const cache = new ExactVisionCache(config.cacheMaxEntries ?? 500, Number.POSITIVE_INFINITY)
  const promptVersion = config.promptVersion ?? 'mindseye-v1'
  const toolName = config.toolName ?? 'mindseye_read_image'

  const mode = process.env.MINDSEYE_MODE?.trim().toLowerCase()
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = setTimeout(() => {
      ctx.logger?.warn('mindseye: settings service did not mount in time; falling back to composition config')
      finish()
    }, 5000)
    ctx.inject(['settings'], (settingsCtx) => {
      const scope = settingsCtx.settings.register(
        MINDSEYE_SETTINGS_NAMESPACE,
        Config,
        { base: config },
      )
      currentConfig = scope.get() as MindsEyeConfig
      settingsWritable = settingsCtx.settings.writable
      persistSettings = async (section) => {
        await settingsCtx.settings.replace(MINDSEYE_SETTINGS_NAMESPACE, section)
      }
      scope.watch(() => {
        currentConfig = scope.get() as MindsEyeConfig
      })

      const takeoverEnabled = mode === 'takeover'
        ? true
        : mode === 'passthrough'
          ? false
          : currentConfig.takeover === true
      clearTimeout(timer)
      const takeoverMessage = `mindseye: takeover ${takeoverEnabled ? 'enabled' : 'disabled'}`
      ctx.logger?.info(takeoverMessage)
      void (async () => {
        if (takeoverEnabled) {
          const bridge = await runTakeover(ctx)
          imageRefs = bridge.imageRefs
          if (bridge.kind === 'skipped') {
            const skippedMessage = 'mindseye: takeover skipped; paste-to-path and file-path vision remain available'
            ctx.logger?.warn(skippedMessage)
          }
        }
        finish()
      })()
    })
  })

  registerHistorySanitizer(ctx, imageRefs)

  registerPasteRoute(ctx, {
    enabled: () => currentConfig.pasteToPath !== false,
  })

  ctx.inject(['credentials'], (credentialsCtx) => {
    credentials = credentialsCtx.credentials
  })

  registerConfigRoute(
    ctx,
    () => currentConfig,
    () => settingsWritable,
    () => persistSettings,
  )

  const readImage = async (input: { path?: string; attachmentId?: string }): Promise<Uint8Array> => {
    if (input.attachmentId !== undefined) {
      const ref = imageRefs.get(input.attachmentId)
      const attachments = ctx.get('attachments') as
        | { readImage: (ref: unknown) => Promise<{ data: Uint8Array }> }
        | undefined
      if (ref === undefined || attachments === undefined) {
        throw new Error(`mindseye: attachment ${input.attachmentId} is not available to the vision bridge`)
      }
      const stored = await attachments.readImage(ref)
      return stored.data
    }
    if (input.path === undefined || input.path === '') {
      throw new Error('mindseye: path is required when attachmentId is not provided')
    }
    const buffer = await readFile(input.path)
    return new Uint8Array(buffer)
  }

  const probeImage = async (bytes: Uint8Array): Promise<{ width: number; height: number; format: string }> => {
    const format = sniffFormat(bytes)
    return { ...probeDimensions(bytes, format), format }
  }

  const toDataUrl = (bytes: Uint8Array, format: string): string =>
    `data:image/${format};base64,${Buffer.from(bytes).toString('base64')}`

  const tool = defineTool({
    name: toolName,
    description: 'Read images with the MindsEye vision bridge. Use whenever a message references images the current model cannot see. RULE: when the request references more than one image, call ONCE with all ids in attachmentIds; never call once per image. locate cannot batch, so call locate once per image. Ask a specific question in query, and optionally set intent: understand for general visual Q&A (description, counting, charts, colors, diffs), extract for verbatim text/OCR, locate for pixel coordinates. Routing rules: text-recognition wording routes to extract, coordinate/location wording routes to locate, otherwise understand; when rules are confident they override the intent hint.',
    parameters: {
      path: { type: 'string', description: 'Absolute path to the image file when no attachmentId is provided.' },
      intent: { type: 'string', enum: ['understand', 'extract', 'locate'], description: 'Optional intent hint; the plugin arbitrates against routing rules.' },
      query: { type: 'string', description: 'Optional question or focus hint.' },
      region: { type: 'string', description: 'Optional pixel region x1,y1,x2,y2.' },
      model: { type: 'string', description: 'Optional model override.' },
      attachmentId: { type: 'string', description: 'Single image attachment id; use attachmentIds instead when more than one image is referenced.' },
      attachmentIds: { type: 'array', items: { type: 'string' }, description: 'Required for multi-image requests: all image attachment ids in one call; locate does not support batching.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          version: { type: 'integer', const: 1, required: true },
          intent: { type: 'string', enum: ['ocr', 'visual-qa', 'grounding', 'layout', 'chart', 'color', 'pixel-diff', 'general'], required: true },
          query: { type: 'string' },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sha256: { type: 'string', required: true },
                path: { type: 'string' },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                format: { type: 'string', required: true },
              },
            },
          },
          evidence: { type: 'object', additionalProperties: true, required: true },
          answer: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              text: { type: 'string', required: true },
              structured: { type: 'json' },
            },
          },
          meta: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
              latencyMs: { type: 'integer', required: true },
              attempts: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
              cache: { type: 'string', enum: ['hit', 'miss'], required: true },
              fallback: { type: 'string' },
              usage: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  inputTokens: { type: 'integer' },
                  outputTokens: { type: 'integer' },
                  totalTokens: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: {
      path?: string
      intent?: 'understand' | 'extract' | 'locate'
      query?: string
      region?: string
      model?: string
      attachmentId?: string
      attachmentIds?: string[]
    }, exec) {
      const classification = resolveRequestIntent(args.query, args.intent)
      const active = currentConfig
      const routeKind = routeKindForIntent(classification.intent)
      const kindRoutes = active.routes?.[routeKind]
      const fallback = routeKind !== 'understand'
        && (kindRoutes === undefined || kindRoutes.length === 0)
        ? `${routeKind}-not-configured`
        : undefined
      const routes = resolveRoutes({
        routes: active.routes ?? {},
        fallbacks: active.fallbacks,
      }, routeKind, {
        model: args.model,
      })
      if (args.attachmentIds !== undefined && args.attachmentIds.length > 0) {
        if (routeKind === 'locate') {
          throw new Error('mindseye: locate does not support batch; call one image at a time')
        }
        const maxBatch = currentConfig.maxBatch ?? 5
        const ids = [...new Set(args.attachmentIds)]
        if (ids.length > maxBatch) {
          throw new Error(`mindseye: batch limit is ${maxBatch} images per call; split into smaller calls`)
        }
        return readImagesWithMindsEye(
          {
            attachmentIds: ids,
            intent: classification.intent,
            query: args.query,
            region: args.region,
            fallback,
          },
          {
            readImage,
            probeImage,
            runVisionBatch: async ({ images, prompt, routes: chainRoutes }) =>
              runVisionBatchChain({
                images,
                prompt,
                routes: chainRoutes,
                resolveApiKey: async (route) => {
                  const provider = credentials
                  return resolveApiKeyValue(route.apiKeyEnv, {
                    env: (name) => process.env[name],
                    resolveCredential: provider === undefined
                      ? undefined
                      : async (name) => provider.resolve(credentialRef(name)),
                  })
                },
                signal: exec.signal,
              }),
            buildBatchPrompt,
            toDataUrl,
          },
          routes,
        )
      }
      const bytes = await readImage({ path: args.path, attachmentId: args.attachmentId })
      const sha256 = fingerprintBytes(bytes)
      const normalizedQuery = normalizeQuery(args.query)
      const key = cacheKeyOf({
        sha256,
        query: normalizedQuery,
        region: args.region,
        baseUrl: normalizeBaseUrl(routes[0]?.baseUrl ?? ''),
        model: args.model ?? routes[0]?.model ?? '',
        promptVersion,
      } satisfies CacheIdentity)
      const cached = cache.get(key)
      if (cached !== undefined) return cached

      const { result } = await readImageWithMindsEye(
        {
          path: args.path,
          attachmentId: args.attachmentId,
          query: args.query,
          region: args.region,
          model: args.model,
          fallback,
        },
        {
          readImage,
          probeImage,
          cache: {
            get: (innerKey) => cache.get(innerKey),
            set: (innerKey, value) => cache.set(innerKey, value),
          },
          runVision: async ({ dataUrl, prompt, route }) => {
            const chain = await runProviderChain({
              routes: [route],
              dataUrl,
              prompt,
              resolveApiKey: async (route) => {
                const provider = credentials
                return resolveApiKeyValue(route.apiKeyEnv, {
                  env: (name) => process.env[name],
                  resolveCredential: provider === undefined
                    ? undefined
                    : async (name) => provider.resolve(credentialRef(name)),
                })
              },
              signal: exec.signal,
            })
            return { analysis: chain.analysis, usage: chain.usage }
          },
          buildPrompt,
          toDataUrl,
        },
        routes,
      )
      return result
    },
  })
  ctx.tools.register(tool)
}

function registerConfigRoute(
  ctx: Context,
  getConfig: () => MindsEyeConfig,
  isWritable: () => boolean,
  getPersist: () => ((section: { routes: unknown; fallbacks: unknown }) => Promise<void>) | undefined,
): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.webServer.register({
      name: 'mindseye-config',
      kind: 'exact',
      path: '/_dsh/mindseye/config',
      handler: async (req: any, res: any) => {
        if (req.method === 'GET') {
          writeJson(res, 200, {
            ok: true,
            value: { config: getConfig(), writable: isWritable() },
          })
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        try {
          const body = await readJsonBody(req)
          const validated = Config(body) as MindsEyeConfig
          const section = {
            routes: validated.routes ?? {},
            fallbacks: validated.fallbacks ?? [],
            ...(validated.takeover === true ? { takeover: true } : {}),
          }
          await getPersist()?.(section)
          writeJson(res, 200, {
            ok: true,
            value: { config: validated, writable: isWritable() },
          })
        } catch (error) {
          writeJson(res, 400, {
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    })
  })
}

async function readJsonBody(req: { on: (event: 'data' | 'end' | 'error', listener: (...args: any[]) => void) => void }): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk))
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 1024 * 1024) {
        reject(new Error('config payload too large'))
      }
    })
    req.on('end', resolve)
    req.on('error', reject)
  })
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config must be an object')
  }
  return parsed as Record<string, unknown>
}

function writeJson(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sniffFormat(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'webp'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))) return 'gif'
  return 'png'
}
