import { describe, expect, it, vi } from 'vitest'
import { runTakeover } from '../src/bridge/takeover.js'

function fakeContext(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  }
}

describe('runTakeover', () => {
  it('registers the wrapper adapter and returns taken', async () => {
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
    expect(registerConfigurableProviders).toHaveBeenCalled()
  })

  it('restores the stock row and returns skipped after failures', async () => {
    const official = {
      disabled: false,
      options: { id: 'llm-deepseek', config: {} },
      update: vi.fn(async (config: { disabled?: boolean }) => {
        if (typeof config.disabled === 'boolean') official.disabled = config.disabled
      }),
    }
    const ctx = fakeContext({
      loader: { entries: () => [official] },
      llm: {
        registerAdapter: vi.fn(() => {
          throw new Error('DUPLICATE_ADAPTER')
        }),
        registerConfigurableProviders: vi.fn(),
      },
    })
    const result = await runTakeover(ctx as never, { maxAttempts: 1 })
    expect(result.kind).toBe('skipped')
    expect(official.update).toHaveBeenLastCalledWith({ disabled: false }, false, true)
    expect(ctx.logger.error).toHaveBeenCalled()
  })
})
