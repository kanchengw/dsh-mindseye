import { describe, expect, it, vi } from 'vitest'
import { runTakeover } from '../src/bridge/takeover.js'

function fakeContext(overrides: Record<string, unknown> = {}) {
  const effectDisposers: Array<() => Promise<void>> = []
  const services: Record<string, unknown> = {
    loader: overrides.loader,
    llm: overrides.llm,
  }
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    get: (name: string) => services[name],
    inject: () => undefined,
    effect: (execute: () => () => void | Promise<void>) => {
      const cleanup = execute()
      const dispose = async () => { await cleanup() }
      effectDisposers.push(dispose)
      return dispose
    },
    disposeEffects: async () => {
      for (const dispose of effectDisposers.reverse()) await dispose()
    },
    ...overrides,
  }
}

describe('runTakeover', () => {
  it('replaces the official route without adding another provider or model', async () => {
    const official = {
      disabled: false,
      options: { id: 'llm-deepseek', config: {} },
      update: vi.fn(async (config: { disabled?: boolean }) => {
        if (typeof config.disabled === 'boolean') official.disabled = config.disabled
      }),
    }
    const registerAdapter = vi.fn(() => ({ replace: vi.fn() }))
    const registerConfigurableProviders = vi.fn()
    const ctx = fakeContext({
      loader: { entries: () => [official] },
      llm: { registerAdapter, registerConfigurableProviders },
    })

    const result = await runTakeover(ctx as never, { maxAttempts: 1 })

    expect(result.kind).toBe('taken')
    expect(official.update).toHaveBeenCalledWith({ disabled: true }, false, true)
    expect(registerAdapter).toHaveBeenCalledWith(['deepseek-official'], expect.anything())
    expect(registerConfigurableProviders).toHaveBeenCalledWith([
      expect.objectContaining({ provider: 'deepseek-official' }),
    ])
    await ctx.disposeEffects()
    expect(official.disabled).toBe(false)
  })

  it('restores the official route after a bridge failure', async () => {
    const official = {
      disabled: false,
      options: { id: 'llm-deepseek', config: {} },
      update: vi.fn(async (config: { disabled?: boolean }) => {
        if (typeof config.disabled === 'boolean') official.disabled = config.disabled
      }),
    }
    const disposeDirectory = vi.fn()
    const ctx = fakeContext({
      loader: { entries: () => [official] },
      llm: {
        registerAdapter: vi.fn(() => {
          throw new Error('DUPLICATE_ADAPTER')
        }),
        registerConfigurableProviders: vi.fn(() => disposeDirectory),
      },
    })

    const result = await runTakeover(ctx as never, { maxAttempts: 1 })

    expect(result.kind).toBe('skipped')
    expect(disposeDirectory).toHaveBeenCalledOnce()
    expect(official.update).toHaveBeenLastCalledWith({ disabled: false }, false, true)
    expect(ctx.logger.error).toHaveBeenCalled()
  })
})
