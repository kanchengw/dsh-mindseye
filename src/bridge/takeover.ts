import type { Context } from '@deepseek-ai/cordis'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek'
import { createNativeDeepSeekAdapter, VisionWrapperAdapter } from './deepseek.js'
import type { ImageAttachmentLike } from './sanitize.js'

export const DEEPSEEK_ROW_ID = 'llm-deepseek'
export const DEEPSEEK_NS = settingsNamespace('llm-deepseek')
export const DEEPSEEK_PROVIDER = 'deepseek-official'

export interface TakeoverResult {
  kind: 'taken' | 'skipped'
  imageRefs: Map<string, ImageAttachmentLike>
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
  ) => (() => void) & { replace: (providers: string[]) => void }
  registerConfigurableProviders: (entries: unknown[]) => () => void
}

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
    log(ctx, 'warn', 'mindseye: adapter bridge needs the loader and llm services')
    return { kind: 'skipped', imageRefs }
  }

  const official = [...loader.entries()].find(entry =>
    entry.options?.id === DEEPSEEK_ROW_ID
    || entry.options?.name === '@deepseek-ai/dsh-llm-deepseek')
  const baseConfig = official?.options?.config ?? {}

  let lastError: unknown
  let restoreOfficial: (() => Promise<void>) | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let disposeDirectory: (() => void) | undefined
    let disposeAdapter: ((() => void) & { replace: (providers: string[]) => void }) | undefined
    try {
      if (official !== undefined && official.disabled !== true) {
        restoreOfficial ??= ctx.effect(
          () => async () => { await official.update({ disabled: false }, false, true) },
          'mindseye: restore official DeepSeek adapter',
        )
        await official.update({ disabled: true }, false, true)
      }

      const native = createNativeDeepSeekAdapter(ctx, baseConfig)
      const wrapper = new VisionWrapperAdapter(native.adapter, imageRefs)
      disposeDirectory = llm.registerConfigurableProviders([{
        provider: DEEPSEEK_PROVIDER,
        displayName: 'DeepSeek',
        settingsNs: DEEPSEEK_NS,
        settingsPath: [],
      }])
      disposeAdapter = llm.registerAdapter([DEEPSEEK_PROVIDER], wrapper)
      let registeredPolicy = native.options().retryPolicy
      const ensureRegistrationFacts = (): void => {
        const policy = native.options().retryPolicy
        if (deepEqualJson(policy, registeredPolicy)) return
        disposeAdapter?.replace([DEEPSEEK_PROVIDER])
        registeredPolicy = policy
      }
      installSettingsSection(ctx, DEEPSEEK_NS, DeepSeekConfig, baseConfig as never, {
        setSource: source => native.setSource(() => source()),
        onChange: ensureRegistrationFacts,
      })
      log(ctx, 'info', 'mindseye: native image bridge is active for deepseek-official')
      return { kind: 'taken', imageRefs }
    } catch (error) {
      disposeAdapter?.()
      disposeDirectory?.()
      lastError = error
      if (attempt < maxAttempts) {
        log(ctx, 'warn', `mindseye: adapter bridge attempt ${attempt}/${maxAttempts} failed; retrying`, error)
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  log(ctx, 'error', 'mindseye: adapter bridge failed; restoring the official adapter', lastError)
  try {
    await restoreOfficial?.()
  } catch {
    // Best-effort restoration keeps the bridge failure as the primary diagnostic.
  }
  return { kind: 'skipped', imageRefs }
}
