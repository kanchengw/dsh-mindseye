import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ExactVisionCache } from './cache.js'
import { Config, MINDSEYE_SETTINGS_NAMESPACE, type MindsEyeConfig } from './config.js'
import { resolveApiKeyValue } from './credentials.js'
import { resolveRoutes } from './routes.js'
import { buildBatchPrompt, buildPrompt } from './prompt.js'
import { runProviderChain, runVisionBatchChain, type BatchVisionResult } from './providers.js'
import { registerHistorySanitizer, runTakeover } from './bridge/takeover.js'
import { registerPasteRoute } from './bridge/paste.js'
import { messagesContainImage, type ImageAttachmentLike } from './bridge/sanitize.js'
import { readImageWithMindsEye, readImagesWithMindsEye } from './tool.js'
import type { RouteKind, TokenUsage, VisionAnalysis, VisionIntent, VisionResult, VisionRoute } from './types.js'
import { probeDimensions } from './bridge/image-meta.js'
import { JsonlMemoryStore } from './memory/store.js'
import { registerMemoryTools } from './memory/tools.js'
import { MetricsCollector, type MetricEvent } from './observability/metrics.js'

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
  const metrics = new MetricsCollector()
  const memoryStore = config.memory === false
    ? undefined
    : new JsonlMemoryStore({
        dir: config.memoryDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mindseye-memory'),
      })
  if (memoryStore !== undefined) await memoryStore.init()

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
  registerMetricsRoute(ctx, () => metrics, () => memoryStore)
  if (memoryStore !== undefined) registerMemoryTools(ctx, memoryStore)

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

  const resolveApiKey = async (route: VisionRoute): Promise<string> => {
    const provider = credentials
    return resolveApiKeyValue(route.apiKeyEnv, {
      env: (name) => process.env[name],
      resolveCredential: provider === undefined
        ? undefined
        : async (name) => provider.resolve(credentialRef(name)),
    })
  }

  const toolServices: VisionToolServices = {
    readImage,
    probeImage,
    toDataUrl,
    memory: memoryStore,
    userNotice: () => currentConfig.userNotice !== false,
    currentConfig: () => currentConfig,
    resolveApiKey,
    cache: {
      get: (key) => cache.get(key),
      set: (key, value) => cache.set(key, value),
    },
    runVision: async ({ dataUrl, prompt, route, signal }) => {
      const chain = await runProviderChain({
        routes: [route],
        dataUrl,
        prompt,
        resolveApiKey,
        signal,
      })
      return { analysis: chain.analysis, usage: chain.usage }
    },
    runVisionBatch: async ({ images, prompt, routes, signal }) =>
      runVisionBatchChain({
        images,
        prompt,
        routes,
        resolveApiKey,
        signal,
      }),
    buildPrompt,
    buildBatchPrompt,
    metrics,
  }

  const readImageTool = defineTool({
    name: config.toolName ?? 'mindseye_read_image',
    description:
      '通用看图工具：查看一张或多张图片并回答相关问题，适合描述画面、数数、识别物体、理解图表和布局等。'
      + '当前模型无法直接看图时，需要看图就用它；文字提取请用 mindseye_ocr，坐标定位请用 mindseye_ground，'
      + '整图颜色请用 mindseye_colors。多张图时一次调用传全部 attachmentIds。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '多图时一次传入全部附件 id，不要逐张调用。',
      },
      query: { type: 'string', description: '要回答的问题或关注点。' },
      region: { type: 'string', description: '可选的原始像素区域 x1,y1,x2,y2，只看该区域。' },
      model: { type: 'string', description: '可选的模型覆盖。' },
    },
    output: VISION_OUTPUT,
    async execute(args, exec) {
      return runVisionTool({
        name: config.toolName ?? 'mindseye_read_image',
        intent: 'visual-qa',
        routeKind: 'understand',
        batchable: true,
      }, args, exec, toolServices)
    },
  })

  const ocrTool = defineTool({
    name: 'mindseye_ocr',
    description:
      '逐字提取图片中的可见文字（OCR），保持原始阅读顺序，不总结、不改写。适合字幕、截图、文档、菜单、表格、车牌等。'
      + '多张图时一次调用传全部 attachmentIds。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '多图时一次传入全部附件 id，不要逐张调用。',
      },
      query: { type: 'string', description: '可选的附加要求，例如指定语言或只看某个区域。' },
      region: { type: 'string', description: '可选的原始像素区域 x1,y1,x2,y2，只看该区域。' },
      model: { type: 'string', description: '可选的模型覆盖。' },
    },
    output: VISION_OUTPUT,
    async execute(args, exec) {
      return runVisionTool({
        name: 'mindseye_ocr',
        intent: 'ocr',
        routeKind: 'extract',
        batchable: true,
      }, args, exec, toolServices)
    },
  })

  const groundTool = defineTool({
    name: 'mindseye_ground',
    description:
      '在图片中定位一个目标并返回它的原始像素边界框 x1,y1,x2,y2，用于点击、裁剪、验证等。'
      + '每次只处理一张图，不支持批量；用 query 描述要定位的目标。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '该工具不支持批量，请每次传入一张图。',
      },
      query: { type: 'string', required: true, description: '要定位的目标描述，例如“发送按钮”。' },
      region: { type: 'string', description: '可选的原始像素区域 x1,y1,x2,y2，只看该区域。' },
      model: { type: 'string', description: '可选的模型覆盖。' },
    },
    output: VISION_OUTPUT,
    async execute(args, exec) {
      return runVisionTool({
        name: 'mindseye_ground',
        intent: 'grounding',
        routeKind: 'locate',
        batchable: false,
        queryRequired: true,
      }, args, exec, toolServices)
    },
  })

  const colorsTool = defineTool({
    name: 'mindseye_colors',
    description:
      '提取图片的主色板并给出每种颜色的占比（hex + share），适合“整张图有哪些颜色”“主色是什么”“配色方案”等问题。'
      + '多张图时一次调用传全部 attachmentIds。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '多图时一次传入全部附件 id，不要逐张调用。',
      },
      query: { type: 'string', description: '可选的附加要求，例如只要主色或只看某个区域。' },
      region: { type: 'string', description: '可选的原始像素区域 x1,y1,x2,y2，只看该区域。' },
      model: { type: 'string', description: '可选的模型覆盖。' },
    },
    output: VISION_OUTPUT,
    async execute(args, exec) {
      return runVisionTool({
        name: 'mindseye_colors',
        intent: 'color',
        routeKind: 'understand',
        batchable: true,
      }, args, exec, toolServices)
    },
  })

  const definitions = [readImageTool, ocrTool, groundTool, colorsTool]

  let visionToolsActive = false
  const visionToolDisposers: Array<() => void> = []
  const activateVisionTools = (): { activated: boolean; tools: string[] } => {
    if (visionToolsActive) return { activated: false, tools: definitions.map((tool) => tool.name) }
    visionToolsActive = true
    for (const tool of definitions) visionToolDisposers.push(ctx.tools.register(tool))
    return { activated: true, tools: definitions.map((tool) => tool.name) }
  }

  ctx.effect(() => () => {
    for (const dispose of visionToolDisposers.splice(0)) dispose()
    visionToolsActive = false
  }, 'mindseye: vision tools')

  ctx.tools.register(defineTool({
    name: 'mindseye_vision_activate',
    description:
      '挂载 MindsEye 视觉工具（mindseye_read_image / mindseye_ocr / mindseye_ground / mindseye_colors）。'
      + '图片轮会自动挂载；纯文本轮需要看图时先调用一次。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activated: { type: 'boolean', required: true },
          tools: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return activateVisionTools()
    },
  }));

  (ctx as any).on('agent/pre-step', async (payload: any, next: () => Promise<unknown>) => {
    const decision = await next()
    if (decision !== null && typeof decision === 'object' && (decision as any).kind === 'reject') {
      return decision
    }
    if (Array.isArray(payload?.messages) && messagesContainImage(payload.messages)) {
      try {
        activateVisionTools()
      } catch (error) {
        ctx.logger?.warn('mindseye: failed to auto-mount vision tools on an image turn', error)
      }
    }
    return decision
  })
}

interface VisionToolSpec {
  name: string
  intent: VisionIntent
  routeKind: RouteKind
  batchable: boolean
  queryRequired?: boolean
}

interface VisionToolServices {
  readImage: (input: { path?: string; attachmentId?: string }) => Promise<Uint8Array>
  probeImage: (bytes: Uint8Array) => Promise<{ width: number; height: number; format: string }>
  toDataUrl: (bytes: Uint8Array, format: string) => string
  memory?: JsonlMemoryStore
  userNotice: () => boolean
  currentConfig: () => MindsEyeConfig
  resolveApiKey: (route: VisionRoute) => Promise<string>
  cache: {
    get: (key: string) => VisionResult | undefined
    set: (key: string, value: VisionResult) => void
  }
  runVision: (options: {
    dataUrl: string
    prompt: string
    route: VisionRoute
    signal?: AbortSignal
  }) => Promise<{ analysis: VisionAnalysis; usage?: TokenUsage }>
  runVisionBatch: (options: {
    images: Array<{ id: string; dataUrl: string }>
    prompt: string
    routes: VisionRoute[]
    signal?: AbortSignal
  }) => Promise<BatchVisionResult>
  buildPrompt: (intent: VisionResult['intent'], query?: string, region?: string) => string
  buildBatchPrompt: (intent: VisionResult['intent'], ids: string[], query?: string, region?: string) => string
  metrics: MetricsCollector
}

const VISION_OUTPUT = {
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
          matchedEvidenceIds: { type: 'array', items: { type: 'string' } },
          softMemoryHits: { type: 'integer' },
          retrievalMs: { type: 'integer' },
          modelCall: { type: 'boolean' },
          source: { type: 'string' },
          userNotice: { type: 'string' },
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
  render: (_args: unknown, value: unknown) => {
    const meta = (value as { meta?: { userNotice?: string } }).meta
    const notice = meta?.userNotice
    const blocks: Array<{ type: 'text'; text: string }> = []
    if (notice !== undefined) {
      blocks.push({
        type: 'text',
        text: `MindsEye 结果（请将以下 userNotice 如实转述给用户）：\n${notice}\n\n完整结果 JSON：`,
      })
    }
    blocks.push({ type: 'text', text: JSON.stringify(value, null, 2) })
    return blocks
  },
} as const

interface VisionToolArgs {
  path?: string
  query?: string
  region?: string
  model?: string
  attachmentId?: string
  attachmentIds?: string[]
}

async function runVisionTool(
  spec: VisionToolSpec,
  args: VisionToolArgs,
  exec: { signal: AbortSignal },
  services: VisionToolServices,
): Promise<VisionResult> {
  const active = services.currentConfig()
  const kindRoutes = active.routes?.[spec.routeKind]
  const fallback = spec.routeKind !== 'understand'
    && (kindRoutes === undefined || kindRoutes.length === 0)
    ? `${spec.routeKind}-not-configured`
    : undefined
  const routes = resolveRoutes({
    routes: active.routes ?? {},
    fallbacks: active.fallbacks,
  }, spec.routeKind, { model: args.model })

  if (args.attachmentIds !== undefined && args.attachmentIds.length > 0) {
    if (spec.routeKind === 'locate') {
      throw new Error(`${spec.name}: locate does not support batch; call one image at a time`)
    }
    const maxBatch = active.maxBatch ?? 5
    const ids = [...new Set(args.attachmentIds)]
    if (ids.length > maxBatch) {
      throw new Error(`${spec.name}: batch limit is ${maxBatch} images per call; split into smaller calls`)
    }
    const batchResult = await readImagesWithMindsEye(
      {
        attachmentIds: ids,
        intent: spec.intent,
        query: args.query,
        region: args.region,
        fallback,
      },
      {
        readImage: services.readImage,
        probeImage: services.probeImage,
        memory: services.memory,
        userNotice: services.userNotice(),
        cache: services.cache,
        runVisionBatch: async ({ images, prompt, routes: chainRoutes }) =>
          services.runVisionBatch({ images, prompt, routes: chainRoutes, signal: exec.signal }),
        buildBatchPrompt: services.buildBatchPrompt,
        toDataUrl: services.toDataUrl,
      },
      routes,
    )
    services.metrics.record(metricOf(batchResult, spec.intent))
    return batchResult
  }

  if (spec.queryRequired && (args.query === undefined || args.query.trim() === '')) {
    throw new Error(`${spec.name}: query is required for this tool`)
  }
  const { result } = await readImageWithMindsEye(
    {
      path: args.path,
      attachmentId: args.attachmentId,
      intent: spec.intent,
      query: args.query,
      region: args.region,
      model: args.model,
      fallback,
    },
    {
      readImage: services.readImage,
      probeImage: services.probeImage,
      memory: services.memory,
      userNotice: services.userNotice(),
      cache: services.cache,
      runVision: async ({ dataUrl, prompt, route }) =>
        services.runVision({ dataUrl, prompt, route, signal: exec.signal }),
      buildPrompt: services.buildPrompt,
      toDataUrl: services.toDataUrl,
    },
    routes,
  )
  services.metrics.record(metricOf(result, spec.intent))
  return result
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

function registerMetricsRoute(
  ctx: Context,
  getMetrics: () => MetricsCollector,
  getMemory: () => JsonlMemoryStore | undefined,
): void {
  ctx.inject(['webServer'], (webCtx: any) => {
    webCtx.webServer.register({
      name: 'mindseye-metrics',
      kind: 'exact',
      path: '/_dsh/mindseye/metrics',
      handler: async (req: any, res: any) => {
        if (req.method !== 'GET') {
          res.writeHead(405).end()
          return
        }
        const memory = getMemory()
        const stats = memory === undefined ? undefined : await memory.stats()
        writeJson(res, 200, {
          ok: true,
          value: {
            summary: getMetrics().summary(),
            recent: getMetrics().recent(50),
            ...(stats === undefined ? {} : { memory: stats }),
          },
        })
      },
    })
  })
}

function metricOf(result: VisionResult, intent: VisionIntent): MetricEvent {
  const meta = result.meta
  return {
    intent,
    source: meta.source ?? 'model',
    cache: meta.cache,
    evidenceHit: (meta.matchedEvidenceIds?.length ?? 0) > 0,
    softMemoryHits: meta.softMemoryHits ?? 0,
    retrievalMs: meta.retrievalMs ?? 0,
    latencyMs: meta.latencyMs,
    modelCall: meta.modelCall ?? false,
    at: Date.now(),
  }
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
