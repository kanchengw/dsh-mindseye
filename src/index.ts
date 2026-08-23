import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ExactVisionCache } from './cache.js'
import { Config, MINDSEYE_SETTINGS_NAMESPACE, resolveMindsEyeConfig, type MindsEyeConfig } from './config.js'
import { resolveApiKeyValue } from './credentials.js'
import { resolveRoutes, routeKindForIntent } from './routes.js'
import { buildBatchPrompt, buildPrompt } from './prompt.js'
import { runProviderChain, runVisionBatchChain, type BatchVisionResult } from './providers.js'
import { runTakeover } from './bridge/takeover.js'
import { registerPasteRoute } from './bridge/paste.js'
import { rememberImageRef } from './bridge/image-refs.js'
import { registerImageTurnActivation } from './bridge/image-turn.js'
import type { ImageAttachmentLike } from './bridge/sanitize.js'
import { sessionAttachmentOf } from './bridge/session-attachment.js'
import { readImageWithMindsEye, readImagesWithMindsEye } from './tool.js'
import { runImageGenerationChain } from './image-generation.js'
import { createImageEditTool, createImageGenerationTool, type CreateImageGenerationToolDeps } from './image-tools.js'
import { prepareGeneration, type PreparedGeneration, type SessionLike } from './prepare.js'
import type { PromptOptions } from './prompt.js'
import type { RouteKind, TokenUsage, VisionAnalysis, VisionIntent, VisionResult, VisionRoute } from './types.js'
import type { EvidenceKind } from './types.js'
import { probeDimensions } from './bridge/image-meta.js'
import { isVisionIntent } from './schema.js'
import { JsonlMemoryStore } from './memory/store.js'
import { registerMemoryTools } from './memory/tools.js'
import { MetricsCollector, type MetricEvent } from './observability/metrics.js'
import { createPuppeteerBrowser, GuiSessionManager } from './gui/browser.js'
import { createGuiTools } from './gui/tools.js'

export { Config, MINDSEYE_SETTINGS_NAMESPACE }
export type { MindsEyeConfig }

export const name = 'mindseye'
export const inject = ['tools', 'attachments', 'userQuestions']

export async function apply(ctx: Context, config: MindsEyeConfig = {}): Promise<void> {
  let currentConfig: MindsEyeConfig = resolveMindsEyeConfig(config)
  let settingsWritable = true
  let credentials: CredentialProvider | undefined
  let persistSettings: ((section: { vision: unknown; image: unknown; gui: unknown }) => Promise<void>) | undefined
  let imageRefs = new Map<string, ImageAttachmentLike>()
  const preparedIntents = new Map<string, { session: unknown; prepared: PreparedGeneration; lastAccessedAt: number }>()
  const PREPARED_TTL_MS = 10 * 60 * 1000
  const PREPARED_MAX = 32
  const MAX_TOOL_RESULTS = 4
  const MAX_TOOL_RESULT_CHARS = 800
  const MAX_TOOL_RESULTS_CHARS = 2400
  const prunePrepared = (): void => {
    const now = Date.now()
    for (const [id, entry] of preparedIntents) {
      if (now - entry.lastAccessedAt > PREPARED_TTL_MS) preparedIntents.delete(id)
    }
    while (preparedIntents.size > PREPARED_MAX) {
      const oldest = [...preparedIntents.entries()].sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0]
      if (oldest === undefined) break
      preparedIntents.delete(oldest[0])
    }
  }
  const loadPrepared = (intentId: string, session: unknown): PreparedGeneration | undefined => {
    prunePrepared()
    const entry = preparedIntents.get(intentId)
    if (entry === undefined || entry.session !== session) return undefined
    entry.lastAccessedAt = Date.now()
    return entry.prepared
  }
  const clearPrepared = (intentId: string, session: unknown): void => {
    const entry = preparedIntents.get(intentId)
    if (entry !== undefined && entry.session === session) preparedIntents.delete(intentId)
  }
  const appendToolResult = (intentId: string, session: unknown, text: string): void => {
    prunePrepared()
    const entry = preparedIntents.get(intentId)
    if (entry === undefined || entry.session !== session) return
    const clipped = text.length > MAX_TOOL_RESULT_CHARS
      ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…`
      : text
    const results = [...(entry.prepared.toolResults ?? []), clipped].slice(-MAX_TOOL_RESULTS)
    while (results.join('\n').length > MAX_TOOL_RESULTS_CHARS && results.length > 1) results.shift()
    entry.prepared.toolResults = results
  }
  const cache = new ExactVisionCache(config.cacheMaxEntries ?? 500, Number.POSITIVE_INFINITY)
  const metrics = new MetricsCollector()
  const memoryStore = config.memory === false
    ? undefined
    : new JsonlMemoryStore({
        dir: config.memoryDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mindseye-memory'),
      })
  if (memoryStore !== undefined) await memoryStore.init()

  const takeover = (async () => {
    const bridge = await runTakeover(ctx)
    imageRefs = bridge.imageRefs
    if (bridge.kind === 'skipped') {
      ctx.logger?.warn('mindseye: native image bridge unavailable; using the path fallback for text-only models')
    }
  })()

  const settingsReady = new Promise<void>((resolve) => {
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
      currentConfig = resolveMindsEyeConfig(scope.get() as MindsEyeConfig)
      settingsWritable = settingsCtx.settings.writable
      persistSettings = async (section) => {
        await settingsCtx.settings.replace(MINDSEYE_SETTINGS_NAMESPACE, section)
      }
      scope.watch(() => {
        currentConfig = resolveMindsEyeConfig(scope.get() as MindsEyeConfig)
        syncImageTools()
        syncGuiTools()
      })

      clearTimeout(timer)
      finish()
    })
  })
  await Promise.all([settingsReady, takeover])

  registerPasteRoute(ctx, { enabled: () => true })

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

  const readImage = async (input: {
    path?: string
    attachmentId?: string
    agent?: unknown
  }): Promise<Uint8Array> => {
    if (input.attachmentId !== undefined) {
      const ref = imageRefs.get(input.attachmentId)
        ?? (input.agent === undefined
          ? undefined
          : sessionAttachmentOf(input.agent, input.attachmentId))
      const attachments = ctx.get('attachments') as
        | { readImage: (ref: unknown) => Promise<{ data: Uint8Array }> }
        | undefined
      if (ref === undefined || attachments === undefined) {
        if (
          input.attachmentId.includes('/')
          || input.attachmentId.includes('\\')
          || /\.(png|jpe?g|webp|gif)$/i.test(input.attachmentId)
        ) {
          throw new Error(
            `mindseye: ${input.attachmentId} 看起来是本地文件路径；本地路径请用 path 参数，附件 id 形如 sha256:...`,
          )
        }
        throw new Error(`mindseye: attachment ${input.attachmentId} is not available`)
      }
      rememberImageRef(imageRefs, input.attachmentId, ref)
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

  const saveGeneratedImage = async (input: {
    data: Uint8Array
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    name?: string
  }): Promise<ImageAttachmentRef> => {
    const ref: ImageAttachmentRef = await ctx.attachments.saveImage(input)
    const attachmentId = String(ref.attachmentId)
    rememberImageRef(imageRefs, attachmentId, ref)
    return ref
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
    runVision: async ({ dataUrl, prompt, routes, signal }) => {
      const chain = await runProviderChain({
        routes,
        dataUrl,
        prompt,
        resolveApiKey,
        signal,
      })
      return {
        analysis: chain.analysis,
        usage: chain.usage,
        provider: chain.provider,
        model: chain.model,
        attempts: chain.attempts.map((attempt) => ({ ...attempt, error: attempt.error ?? '' })),
      }
    },
    runVisionBatch: async ({ images, prompt, routes, signal }) =>
      runVisionBatchChain({
        images,
        prompt,
        routes,
        resolveApiKey,
        signal,
      }),
    loadPrepared,
    appendToolResult,
    buildPrompt,
    buildBatchPrompt,
    metrics,
  }

  const readImageTool = defineTool({
    name: 'mindseye_read_image',
    description:
      '通用看图/提取工具：查看一张或多张图片并回答相关问题，或用 intent 选择专项任务。'
      + '当前模型无法直接看图时，看图就用它；问题从用户当轮消息严格提取，禁止改写或扩写；'
      + 'intent 选任务类型（默认 visual-qa），可覆盖 ocr / layout / chart / color / pixel-diff / general；'
      + '需要一次拿多种结构化证据时用 extract（ocr / colors / layout），不要重复调用；'
      + '坐标定位请用 mindseye_ground；多张图时一次调用传全部 attachmentIds。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '多图时一次传入全部附件 id，不要逐张调用。',
      },
      intentId: {
        type: 'string',
        required: true,
        description: '必须先用 mindseye_plan 提取当轮需求后返回的 intentId。',
      },
      intent: {
        type: 'string',
        description: '任务类型，默认 visual-qa；可选 visual-qa / ocr / layout / chart / color / pixel-diff / general。',
        enum: ['visual-qa', 'ocr', 'layout', 'chart', 'color', 'pixel-diff', 'general'],
      },
      extract: {
        type: 'array',
        items: { type: 'string', enum: ['ocr', 'colors', 'layout'] },
        description: '一次请求多种结构化证据，例如 ["ocr","colors"]。',
      },
      model: { type: 'string', description: '可选的模型覆盖。' },
    },
    output: VISION_OUTPUT,
    async execute(args, exec) {
      return runVisionTool({
        name: 'mindseye_read_image',
        intent: 'visual-qa',
        routeKind: 'understand',
        batchable: true,
      }, args, exec, toolServices)
    },
  })


  const groundTool = defineTool({
    name: 'mindseye_ground',
    description:
      '在图片中定位一个目标并返回它的原始像素边界框 x1,y1,x2,y2，用于点击、裁剪、验证等。'
      + '定位目标从用户当轮消息严格提取，禁止改写或扩写；每次只处理一张图，不支持批量。',
    parameters: {
      path: { type: 'string', description: '本地图片绝对路径；提供 attachmentId 时无需填写。' },
      attachmentId: { type: 'string', description: '会话中上传的图片附件 id（如 sha256:...）。' },
      attachmentIds: {
        type: 'array',
        items: { type: 'string' },
        description: '该工具不支持批量，请每次传入一张图。',
      },
      intentId: {
        type: 'string',
        required: true,
        description: '必须先用 mindseye_plan 提取当轮需求后返回的 intentId。',
      },
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


  const definitions = [readImageTool, groundTool]

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

  const imageToolDeps: CreateImageGenerationToolDeps = {
    routes: () => currentConfig.image?.generate ?? [],
    editsRoutes: () => currentConfig.image?.edit ?? [],
    readImage: (input: { attachmentId: string; agent?: unknown }) => readImage({ attachmentId: input.attachmentId, agent: input.agent }),
    generate: (spec, routes, signal) => runImageGenerationChain({ routes, spec, resolveApiKey, signal }),
    saveImage: saveGeneratedImage,
    probeImage: (bytes) => {
      const format = sniffFormat(bytes)
      return { ...probeDimensions(bytes, format), format }
    },
    loadPrepared,
    clearPrepared,
    onGenerated: () => {
      try {
        activateVisionTools()
      } catch {
        // Vision tools are best-effort after generation so the model can inspect the result on demand.
      }
    },
  }

  const imageToolDisposers: Array<() => void> = []
  function syncImageTools(): void {
    for (const dispose of imageToolDisposers.splice(0)) dispose()
    const routes = currentConfig.image?.generate ?? []
    const edits = currentConfig.image?.edit ?? []
    if (routes.length > 0) {
      imageToolDisposers.push(ctx.tools.register(createImageGenerationTool(imageToolDeps)))
    }
    if (edits.length > 0) {
      imageToolDisposers.push(ctx.tools.register(createImageEditTool(imageToolDeps)))
    }
  }
  syncImageTools()

  ctx.effect(() => () => {
    for (const dispose of imageToolDisposers.splice(0)) dispose()
  }, 'mindseye: image tools')

  let guiBrowserPromise: ReturnType<typeof createPuppeteerBrowser> | undefined
  let guiManager: GuiSessionManager | undefined
  const guiToolDisposers: Array<() => void> = []
  const syncGuiTools = (): void => {
    for (const dispose of guiToolDisposers.splice(0)) dispose()
    const previousManager = guiManager
    guiManager = undefined
    guiBrowserPromise = undefined
    void previousManager?.closeAll().catch(() => undefined)
    if (currentConfig.gui?.enabled !== true) {
      return
    }
    const guiConfig = currentConfig.gui
    const browser = {
      open: async (url: string, options: { timeoutMs: number }) => {
        guiBrowserPromise ??= createPuppeteerBrowser({
          browser: guiConfig.browser ?? 'auto',
          headless: false,
          ...(guiConfig.executablePath === undefined ? {} : { executablePath: guiConfig.executablePath }),
        })
        return (await guiBrowserPromise).open(url, options)
      },
    }
    guiManager = new GuiSessionManager({
      browser,
      saveImage: async (input) => {
        const ref = await ctx.attachments.saveImage(input)
        return ref
      },
      restrictHosts: guiConfig.restrictHosts ?? false,
      allowedHosts: guiConfig.allowedHosts ?? [],
      maxSteps: guiConfig.maxSteps ?? 20,
      timeoutMs: guiConfig.timeoutMs ?? 30_000,
    })
    for (const tool of createGuiTools(guiManager, {
      askUser: (request) => ctx.userQuestions.ask(request as never),
    })) guiToolDisposers.push(ctx.tools.register(tool))
  }
  syncGuiTools()

  ctx.effect(() => async () => {
    for (const dispose of guiToolDisposers.splice(0)) dispose()
    await guiManager?.closeAll()
  }, 'mindseye: gui tools')

  ctx.tools.register(defineTool({
    name: 'mindseye_plan',
    description:
      '两段式第一步：严格提取用户当轮需求，只做提取，不扩写、不改写。'
      + 'context 是唯一补充字段，仅当用户当轮需求缺少必要历史背景时填写，并且必须用 contextEvidence 逐字引用历史用户消息或附件 id 作为依据；'
      + 'size 仅用于生图，只有当用户明确或隐含提出尺寸需求时填写，并必须用 sizeEvidence 给出用户原文依据；'
      + '没有尺寸需求时 size 和 sizeEvidence 都必须留空。'
      + '返回的 intentId 必须传给后续 mindseye_read_image / mindseye_ground / mindseye_generate_image / mindseye_edit_image 工具；'
      + '如果用户上传图片并要求“改成/换成/参考这张图/重做这种风格”，这属于图生图，应直接用 mindseye_edit_image 传 attachmentId，不要搜索项目代码；'
      + 'OCR、颜色、布局等专项任务统一用 mindseye_read_image 的 intent / extract 参数完成。',
    parameters: {
      context: {
        type: 'string',
        description: '可选补充背景，仅补当前轮缺失且必要的历史信息，克制；内容必须能在历史中找到依据。',
      },
      contextEvidence: {
        type: 'array',
        items: { type: 'string' },
        description: '支撑 context 的历史用户原文片段或附件 id，必须逐字来自历史消息。',
      },
      size: {
        type: 'string',
        description: '可选，仅生图。OpenAI-compatible 枚举：auto、1024x1024、1536x1024 或 1024x1536。',
      },
      sizeEvidence: {
        type: 'string',
        description: '支撑 size 的用户原文引用，必须逐字来自用户消息。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          intentId: { type: 'string', required: true },
          currentRequest: { type: 'string', required: true },
          context: { type: 'string' },
          contextEvidence: { type: 'array', items: { type: 'string' } },
          historyContext: { type: 'array', items: { type: 'string' } },
          toolResults: { type: 'array', items: { type: 'string' } },
          size: { type: 'string' },
          sizeEvidence: { type: 'string' },
          validation: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              context: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean', required: true },
                  reason: { type: 'string' },
                },
              },
              size: {
                type: 'object',
                required: true,
                additionalProperties: false,
                properties: {
                  ok: { type: 'boolean', required: true },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const raw = args as { context?: string; contextEvidence?: string[]; size?: string; sizeEvidence?: string }
      const rawSizeEvidence = raw.sizeEvidence?.trim() ?? ''
      const prepared = prepareGeneration({
        context: raw.context,
        contextEvidence: raw.contextEvidence,
        size: raw.size,
        sizeEvidence: rawSizeEvidence === '' ? undefined : rawSizeEvidence,
        exec: exec as SessionLike,
      })
      const intentId = randomUUID()
      preparedIntents.set(intentId, { session: exec.agent?.session, prepared, lastAccessedAt: Date.now() })
      prunePrepared()
      return {
        intentId,
        currentRequest: prepared.currentRequest,
        ...(prepared.context === undefined ? {} : { context: prepared.context }),
        ...(prepared.contextEvidence === undefined ? {} : { contextEvidence: prepared.contextEvidence }),
        ...(prepared.historyContext === undefined ? {} : { historyContext: prepared.historyContext }),
        ...(prepared.toolResults === undefined ? {} : { toolResults: prepared.toolResults }),
        ...(rawSizeEvidence === '' ? {} : { sizeEvidence: rawSizeEvidence }),
        ...(prepared.size === undefined ? {} : { size: prepared.size }),
        validation: {
          context: prepared.contextReason === undefined
            ? { ok: true }
            : { ok: false, reason: prepared.contextReason },
          size: prepared.sizeReason === undefined
            ? { ok: true }
            : { ok: false, reason: prepared.sizeReason },
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mindseye_vision_activate',
    description:
      '挂载 MindsEye 视觉工具（mindseye_read_image / mindseye_ground）。'
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

  registerImageTurnActivation(ctx, activateVisionTools)
}

interface VisionToolSpec {
  name: string
  intent: VisionIntent
  routeKind: RouteKind
  batchable: boolean
  queryRequired?: boolean
}

interface VisionToolServices {
  readImage: (input: { path?: string; attachmentId?: string; agent?: unknown }) => Promise<Uint8Array>
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
    routes: VisionRoute[]
    signal?: AbortSignal
  }) => Promise<{
    analysis: VisionAnalysis
    usage?: TokenUsage
    provider?: string
    model?: string
    attempts?: VisionResult['meta']['attempts']
  }>
  runVisionBatch: (options: {
    images: Array<{ id: string; dataUrl: string }>
    prompt: string
    routes: VisionRoute[]
    signal?: AbortSignal
  }) => Promise<BatchVisionResult>
  loadPrepared: (intentId: string, session: unknown) => PreparedGeneration | undefined
  appendToolResult: (intentId: string, session: unknown, text: string) => void
  buildPrompt: (intent: VisionResult['intent'], options?: PromptOptions) => string
  buildBatchPrompt: (intent: VisionResult['intent'], ids: string[], options?: PromptOptions) => string
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
          attempts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                model: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                latencyMs: { type: 'integer', required: true },
                error: { type: 'string', required: true },
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
  intentId?: string
  model?: string
  attachmentId?: string
  attachmentIds?: string[]
  intent?: string
  extract?: string[]
}

function normalizeExtractArgs(extract: string[] | undefined): EvidenceKind[] {
  if (!Array.isArray(extract)) return []
  const kinds: EvidenceKind[] = []
  for (const value of extract) {
    if (value === 'ocr' || value === 'layout' || value === 'colors') {
      kinds.push(value)
    } else {
      throw new Error('mindseye_read_image: extract 只支持 ocr / colors / layout')
    }
  }
  return [...new Set(kinds)]
}

async function runVisionTool(
  spec: VisionToolSpec,
  args: VisionToolArgs,
  exec: { signal: AbortSignal; agent?: unknown },
  services: VisionToolServices,
): Promise<VisionResult> {
  const active = services.currentConfig()
  const requestedIntent = args.intent?.trim()
  const intent: VisionIntent = spec.intent === 'grounding'
    ? spec.intent
    : requestedIntent !== undefined && isVisionIntent(requestedIntent)
      ? requestedIntent
      : spec.intent
  const extract = normalizeExtractArgs(args.extract)
  const routeKind = routeKindForIntent(intent)
  const kindRoutes = active.vision?.routes?.[routeKind]
  const fallback = routeKind !== 'understand'
    && (kindRoutes === undefined || kindRoutes.length === 0)
    ? `${routeKind}-not-configured`
    : undefined
  const routes = resolveRoutes({
    routes: active.vision?.routes ?? {},
    fallbacks: active.vision?.fallbacks,
  }, routeKind, { model: args.model })
  if (args.intentId === undefined) {
    throw new Error(`${spec.name}: 请先调用 mindseye_plan 获取 intentId`)
  }
  const session = (exec.agent as { session?: unknown } | undefined)?.session
  const prepared = services.loadPrepared(args.intentId, session)
  if (prepared === undefined) {
    throw new Error(`${spec.name}: intentId 无效或已失效，请重新调用 mindseye_plan`)
  }

  if (args.attachmentIds !== undefined && args.attachmentIds.length > 0) {
    if (routeKind === 'locate') {
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
        agent: exec.agent,
        intent,
        extract,
        query: prepared.currentRequest,
        context: prepared.context,
        historyContext: prepared.historyContext,
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
    services.metrics.record(metricOf(batchResult, intent))
    services.appendToolResult(args.intentId, session, `[识图 ${batchResult.intent}] ${batchResult.answer.text}`)
    return batchResult
  }

  if (spec.queryRequired && prepared.currentRequest === '') {
    throw new Error(`${spec.name}: 当前轮用户消息没有可提取的定位目标`)
  }
  const { result } = await readImageWithMindsEye(
    {
      path: args.path,
      attachmentId: args.attachmentId,
      agent: exec.agent,
      intent,
      extract,
      query: prepared.currentRequest,
      context: prepared.context,
      historyContext: prepared.historyContext,
      model: args.model,
      fallback,
    },
    {
      readImage: services.readImage,
      probeImage: services.probeImage,
      memory: services.memory,
      userNotice: services.userNotice(),
      cache: services.cache,
      runVision: async ({ dataUrl, prompt, routes: chainRoutes }) =>
        services.runVision({ dataUrl, prompt, routes: chainRoutes, signal: exec.signal }),
      buildPrompt: services.buildPrompt,
      toDataUrl: services.toDataUrl,
    },
    routes,
  )
  services.metrics.record(metricOf(result, intent))
  services.appendToolResult(args.intentId, session, `[识图 ${result.intent}] ${result.answer.text}`)
  return result
}

function registerConfigRoute(
  ctx: Context,
  getConfig: () => MindsEyeConfig,
  isWritable: () => boolean,
  getPersist: () => ((section: { vision: unknown; image: unknown; gui: unknown }) => Promise<void>) | undefined,
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
          const validated = resolveMindsEyeConfig(Config(body) as MindsEyeConfig)
          const section = {
            vision: {
              routes: validated.vision.routes,
              fallbacks: validated.vision.fallbacks,
            },
            image: {
              generate: validated.image.generate,
              edit: validated.image.edit,
            },
            gui: validated.gui,
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
