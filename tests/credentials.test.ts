import { describe, expect, it } from 'vitest'
import { resolveApiKeyValue } from '../src/credentials.js'

describe('resolveApiKeyValue', () => {
  const deps = {
    env: () => undefined,
  }

  it('resolves an environment variable name', async () => {
    await expect(resolveApiKeyValue('DASHSCOPE_API_KEY', {
      env: (name) => name === 'DASHSCOPE_API_KEY' ? 'sk-env-value' : undefined,
    })).resolves.toBe('sk-env-value')
  })

  it('resolves a dsh credential reference when env is missing', async () => {
    await expect(resolveApiKeyValue('DASHSCOPE_API_KEY', {
      ...deps,
      resolveCredential: async (name) =>
        name === 'DASHSCOPE_API_KEY' ? { value: 'sk-cred-value' } : undefined,
    })).resolves.toBe('sk-cred-value')
  })

  it('treats a non-identifier value as a literal key', async () => {
    await expect(resolveApiKeyValue('test-api-key-value', deps))
      .resolves.toBe('test-api-key-value')
  })

  it('throws for an unresolved identifier', async () => {
    await expect(resolveApiKeyValue('MISSING_API_KEY', deps))
      .rejects.toThrow('missing credential MISSING_API_KEY')
  })

  it('throws for an empty value', async () => {
    await expect(resolveApiKeyValue('   ', deps)).rejects.toThrow('api key is empty')
  })
})
