import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createNativeDeepSeekAdapter, VisionWrapperAdapter } from './deepseek.js'
import {
  collectImageRefs,
  messagesContainImage,
  sanitizeMessages,
  type ImageAttachmentLike,
  type MessageLike,
} from './sanitize.js'

export const DEEPSEEK_ROW_ID = 'llm-deepseek'
export const DEEPSEEK_NS = settingsNamespace('llm-deepseek')
export const DEEPSEEK_PROVIDER = 'deepseek-official'

export interface TakeoverResult {
  kind: 'taken' | 'skipped'
  imageRefs: Map<string, ImageAttachmentLike>
}

/**
 * Protect sessions that already contain image blocks after the takeover is
 * disabled or failed: a `llm/stream` listener rewrites history images into
 * attachment markers before the official text-only adapter serializes them.
 */
export function registerHistorySanitizer(
  ctx: Context,
  imageRefs: Map<string, ImageAttachmentLike>,
): void {
  ctx.on('llm/stream', (
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> => {
    const messages = options.messages as unknown as MessageLike[]
    if (options.provider !== DEEPSEEK_PROVIDER || !messagesContainImage(messages)) {
      return next()
    }
    for (const ref of collectImageRefs(messages)) {
      const id = String(ref.attachmentId ?? ref.id ?? '')
      if (id !== '') imageRefs.set(id, ref)
    }
    const sanitized = sanitizeMessages(messages)
    if (messagesContainImage(sanitized)) return next()
    const llm = ctx.get('llm') as
      | { stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }
      | undefined
    if (llm === undefined) return next()
    return llm.stream({
      ...options,
      messages: sanitized as unknown as typeof options.messages,
    })
  })
}

export interface TakeoverOptions {
  maxAttempts?: number
  retryDelayMs?: number
}

interface LoaderEntryLike {
  disabled?: boolean
  options?: { id?: string; name?: string; config?: unknown }
  update: (config: Record<string, unknown>, create?: boolean, force?: boolean) => Promise<void>
}

interface LoaderLike {
  entries: () => Iterable<LoaderEntryLike>
}

interface LlmLike {
  registerAdapter: (
    providers: string[],
    adapter: unknown,
  ) => { replace: (providers: string[]) => void }
  registerConfigurableProviders: (entries: unknown[]) => unknown
}

/**
 * Take over `deepseek-official` for the current boot only: disable the stock
 * row through the loader without persisting, register a minimal delegating
 * adapter, and restore the stock row if anything fails. No composition edits
 * and no hidden routes are involved.
 */
export async function runTakeover(
  ctx: Context,
  options: TakeoverOptions = {},
): Promise<TakeoverResult> {
  const run = takeoverQueue.then(() => runTakeoverUnlocked(ctx, options))
  takeoverQueue = run.then(() => undefined, () => undefined)
  return run
}

let takeoverQueue: Promise<void> = Promise.resolve()

function log(ctx: Context, level: 'info' | 'warn' | 'error', message: string, error?: unknown): void {
  if (level === 'info') ctx.logger?.info(message)
  if (level === 'warn') ctx.logger?.warn(message)
  if (level === 'error') ctx.logger?.error(message)
  if (error !== undefined) {
    if (level === 'error') ctx.logger?.error(error)
    else ctx.logger?.warn(error)
  }
}

async function runTakeoverUnlocked(
  ctx: Context,
  options: TakeoverOptions,
): Promise<TakeoverResult> {
  const imageRefs = new Map<string, ImageAttachmentLike>()
  const maxAttempts = options.maxAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 200
  const loader = ctx.get('loader') as LoaderLike | undefined
  const llm = ctx.get('llm') as LlmLike | undefined
  if (loader === undefined || llm === undefined) {
    log(ctx, 'warn', 'takeover needs the loader and llm services; skipping the image bridge')
    return { kind: 'skipped', imageRefs }
  }

  const official = [...loader.entries()].find((entry) =>
    entry.options?.id === DEEPSEEK_ROW_ID
    || entry.options?.name === '@deepseek-ai/dsh-llm-deepseek')
  const baseConfig = official?.options?.config ?? {}

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (official !== undefined && official.disabled !== true) {
        await official.update({ disabled: true }, false, true)
      }

      const native = createNativeDeepSeekAdapter(ctx, baseConfig)
      const wrapper = new VisionWrapperAdapter(native.adapter, imageRefs)
      llm.registerConfigurableProviders([{
        provider: DEEPSEEK_PROVIDER,
        displayName: 'DeepSeek',
        settingsNs: DEEPSEEK_NS,
        settingsPath: [],
      }])
      const registration = llm.registerAdapter([DEEPSEEK_PROVIDER], wrapper)
      let registeredPolicy = native.options().retryPolicy
      const ensureRegistrationFacts = (): void => {
        const policy = native.options().retryPolicy
        if (deepEqualJson(policy, registeredPolicy)) return
        registration.replace([DEEPSEEK_PROVIDER])
        registeredPolicy = policy
      }
      installSettingsSection(ctx, DEEPSEEK_NS, DeepSeekConfig, baseConfig as never, {
        setSource: (source) => native.setSource(() => source()),
        onChange: ensureRegistrationFacts,
      })
      log(ctx, 'info', 'took over deepseek-official; native image pastes now pass admission')
      return { kind: 'taken', imageRefs }
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        log(ctx, 'warn', `takeover attempt ${attempt}/${maxAttempts} failed; retrying in ${retryDelayMs}ms`, error)
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  log(ctx, 'error',
    'deepseek-official takeover failed after '
    + `${maxAttempts} attempts; restoring the stock row and continuing without the image bridge. `
    + 'Likely causes: incompatible @deepseek-ai/dsh-llm-deepseek version, corrupt llm-deepseek settings, '
    + 'or a missing credentials service. Set MINDSEYE_MODE=passthrough (or takeover: false) and restart '
    + 'to stay on the official adapter, then inspect the errors above.',
  )
  log(ctx, 'error', 'takeover failure details', lastError)
  if (official !== undefined && official.disabled === true) {
    try {
      await official.update({ disabled: false }, false, true)
    } catch {
      // best-effort restore
    }
  }
  return { kind: 'skipped', imageRefs }
}
