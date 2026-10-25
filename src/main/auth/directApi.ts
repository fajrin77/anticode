import { DIRECT_AUTH_PROVIDERS, type DirectAuthKind } from '@shared/directAuthProviders'
import type { AuthLoginCallbacks, AuthTokens } from './types'
export async function directApiModels(kind: DirectAuthKind, key: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${DIRECT_AUTH_PROVIDERS[kind].baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: signal ?? AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${DIRECT_AUTH_PROVIDERS[kind].label} catalogue failed (${response.status}). Check API key and account access.`)
  const body = await response.json() as { data?: { id?: unknown }[] }
  const models = [...new Set((body.data ?? []).flatMap((row) => typeof row.id === 'string' && row.id.trim() ? [row.id] : []))]
  if (!models.length) throw new Error('No account model IDs returned. A valid live catalogue is required.')
  return models
}
export async function loginDirectApi(kind: DirectAuthKind, callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const config = DIRECT_AUTH_PROVIDERS[kind]
  callbacks.onUpdate({ message: `${config.label}: ${config.hint} Paste your API key to validate access. This is not browser OAuth.`, url: config.website })
  const key = (await callbacks.promptForCode(`${config.label} API key`)).trim()
  callbacks.signal.throwIfAborted()
  if (!key || /\s/.test(key)) throw new Error('Enter a valid API key without whitespace')
  const models = await directApiModels(kind, key, callbacks.signal)
  callbacks.onUpdate({ message: 'API key validated', done: true })
  return { accessToken: key, expiresAt: 0, meta: { account: config.label, directModels: JSON.stringify(models) } }
}
