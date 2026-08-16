import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  type DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import {
  collectImageRefs,
  sanitizeMessages,
  type ImageAttachmentLike,
  type MessageLike,
} from './sanitize.js'

const IMAGE_INPUT = ['text', 'image'] as const

export interface NativeDeepSeek {
  adapter: DeepSeekAdapter
  options: () => DeepSeekConnectionOptions
  setSource: (source: () => unknown) => void
}

interface EnvLayer {
  get: (name: string) => { value: string | undefined } | undefined
}

function launchEnvironmentLike(env: Record<string, string | undefined>): EnvLayer {
  return {
    get(name) {
      return Object.prototype.hasOwnProperty.call(env, name) ? { value: env[name] } : undefined
    },
  }
}

/**
 * Rebuild the stock DeepSeek adapter with the same resolution chain the
 * official `llm-deepseek` row uses: settings section, credential seam, and
 * the harness-home anonymous id.
 */
export function createNativeDeepSeekAdapter(ctx: Context, base: unknown): NativeDeepSeek {
  const env = launchEnvironmentLike(process.env)
  let current: () => unknown = () => base
  let lastRaw: unknown
  let lastGood: DeepSeekConnectionOptions | undefined

  const options = (): DeepSeekConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw as never, env as never)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger?.error('mindseye: keeping the last good llm-deepseek configuration after an invalid settings section')
      ctx.logger?.error(error)
      return lastGood
    }
  }

  const resolveApiKey = async (connection: DeepSeekConnectionOptions): Promise<string> => {
    const ref = String(connection.apiKeyEnv)
    const credentials = ctx.get('credentials') as
      | { resolve: (ref: unknown) => Promise<{ value: string } | undefined> }
      | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(connection.apiKeyEnv)
      const value = hit?.value.trim()
      if (value !== undefined && value !== '') return value
    }
    const ambient = env.get(ref)
    if (ambient !== undefined && ambient.value !== undefined && ambient.value.trim() !== '') {
      return ambient.value.trim()
    }
    throw new Error(`mindseye: no API key for the native DeepSeek route (${ref})`)
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()

  return {
    adapter: new DeepSeekAdapter({ options, resolveApiKey, resolveUserId }),
    options,
    setSource: (source) => {
      current = source
    },
  }
}

/**
 * The minimal stealth adapter: delegates every call to the real DeepSeek
 * adapter, stamps image input so admission passes, and rewrites image blocks
 * into attachment markers before delegating the stream. All vision work stays
 * in the MindsEye tools.
 */
export class VisionWrapperAdapter extends LlmAdapter {
  constructor(
    private readonly native: DeepSeekAdapter,
    private readonly imageRefs: Map<string, ImageAttachmentLike>,
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return this.native.providerInfo(provider)
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.native.providerRetryPolicy(provider)
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const listed = await this.native.listModels(provider)
    return listed.map((model) => ({ ...model, inputModalities: IMAGE_INPUT }))
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await this.native.resolveModel(provider, model, signal)
    return { ...resolved, inputModalities: IMAGE_INPUT }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages as unknown as MessageLike[]
    for (const ref of collectImageRefs(messages)) {
      const id = String(ref.attachmentId ?? ref.id ?? '')
      if (id !== '') this.imageRefs.set(id, ref)
    }
    const sanitized = sanitizeMessages(messages) as unknown as typeof options.messages
    yield* this.native.stream({ ...options, messages: sanitized })
  }
}
