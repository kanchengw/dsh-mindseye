import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import type { Context } from '@deepseek-ai/cordis'
import {
  assertUsableApiKey,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  DeepSeekAdapter,
  resolveAdapterOptions,
  type DeepSeekConnectionOptions,
} from '@deepseek-ai/dsh-llm-deepseek'
import { rememberImageRef } from './image-refs.js'
import {
  collectImageRefs,
  messagesContainImage,
  sanitizeMessages,
  type ImageAttachmentLike,
  type MessageLike,
} from './sanitize.js'

const COMPOSED_IMAGE_INPUT = ['text', 'image'] as const

export interface NativeDeepSeek {
  adapter: DeepSeekAdapter
  options: () => DeepSeekConnectionOptions
  setSource: (source: () => unknown) => void
}

export function createNativeDeepSeekAdapter(ctx: Context, base: unknown): NativeDeepSeek {
  let current: () => unknown = () => base
  let lastRaw: unknown
  let lastGood: DeepSeekConnectionOptions | undefined

  const options = (): DeepSeekConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw as never, launchEnvironmentOf(ctx))
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
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials') as
      | { resolve: (ref: unknown) => Promise<{ value: string } | undefined> }
      | undefined
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'mindseye', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(String(ref))
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'mindseye', ref)
      }
    }
    throw new LlmError(
      `mindseye: no API key for provider route "deepseek-official" (${String(ref)})`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()

  return {
    adapter: new DeepSeekAdapter({
      options,
      resolveApiKey,
      resolveUserId,
      resolveAttachments: () => ctx.get('attachments'),
    }),
    options,
    setSource: (source) => {
      current = source
    },
  }
}

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
    return listed.map(model => ({ ...model, inputModalities: COMPOSED_IMAGE_INPUT }))
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await this.native.resolveModel(provider, model, signal)
    return { ...resolved, inputModalities: COMPOSED_IMAGE_INPUT }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = options.messages as unknown as MessageLike[]
    if (!messagesContainImage(messages)) {
      yield* this.native.stream(options)
      return
    }

    for (const ref of collectImageRefs(messages)) {
      const id = String(ref.attachmentId ?? ref.id ?? '')
      if (id !== '') rememberImageRef(this.imageRefs, id, ref)
    }

    const nativeModel = await this.native.resolveModel(options.provider, options.model, options.signal)
    if (nativeModel.inputModalities?.includes('image') === true) {
      yield* this.native.stream(options)
      return
    }

    const sanitized = sanitizeMessages(messages) as unknown as typeof options.messages
    yield* this.native.stream({ ...options, messages: sanitized })
  }
}
