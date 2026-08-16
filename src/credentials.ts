const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ApiKeyLookupDeps {
  env: (name: string) => string | undefined
  resolveCredential?: (name: string) => Promise<{ value: string } | undefined>
}

export async function resolveApiKeyValue(
  value: string,
  deps: ApiKeyLookupDeps,
): Promise<string> {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new Error('mindseye: api key is empty')
  }

  const envValue = deps.env(trimmed)
  if (envValue !== undefined && envValue !== '') return envValue

  if (deps.resolveCredential !== undefined) {
    const resolved = await deps.resolveCredential(trimmed).catch(() => undefined)
    if (resolved !== undefined && resolved.value !== '') return resolved.value
  }

  if (!ENV_NAME_PATTERN.test(trimmed)) return trimmed

  throw new Error(`mindseye: missing credential ${trimmed}`)
}
