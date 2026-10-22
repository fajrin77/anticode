import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * OpenRouter PKCE. Without `callback_url` OpenRouter finishes on its own
 * dashboard and the app never hears back, so the browser is sent to a
 * localhost callback (any port is accepted). The paste box stays open as a
 * fallback for the headless display-code page.
 */
export async function loginOpenRouter(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const verifier = makeVerifier()
  const signal = AbortSignal.any([callbacks.signal, AbortSignal.timeout(10 * 60_000)])
  const callbackPath = `/openrouter/${makeState()}`
  const local = new AbortController()
  const callback = waitForCallback({
    ports: [0],
    path: callbackPath,
    signal: AbortSignal.any([signal, local.signal]),
    onListening: (port) => {
      const url = new URL('https://openrouter.ai/auth')
      url.searchParams.set('callback_url', `http://localhost:${port}${callbackPath}`)
      url.searchParams.set('code_challenge', makeChallenge(verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('key_label', 'Anticode Free')
      callbacks.onUpdate({ message: 'Setujui akses di OpenRouter; Anticode menerima kodenya otomatis.', url: url.toString() })
      void shell.openExternal(url.toString())
    }
  }).then(result => {
    if (result.error !== undefined) throw new Error(`OpenRouter authorization was declined (${result.error}).`)
    return result.code
  })
  const code = await new Promise<string>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('OpenRouter login expired or was cancelled. Start Sign in again.')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    const settle = (value: string): void => { signal.removeEventListener('abort', abort); resolve(value) }
    const fail = (error: unknown): void => { if (!signal.aborted) { signal.removeEventListener('abort', abort); reject(error) } }
    callback.then(settle, fail)
    callbacks.promptForCode('Jika browser menampilkan kode, tempel di sini').then(settle, fail)
  }).finally(() => local.abort())
  signal.throwIfAborted()
  if (!code.trim() || /\s/.test(code.trim()) || code.trim().startsWith('sk-') || /^https?:/i.test(code.trim())) throw new Error('Paste the single-use OpenRouter authorization code, not an API key or dashboard URL. Open the authorization link again to obtain a code.')
  const response = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  })
  if (!response.ok) throw new Error(`OpenRouter authorization exchange failed (HTTP ${response.status}). Start Sign in again for a fresh code.`)
  const data = await response.json() as { key?: unknown; user_id?: unknown }
  signal.throwIfAborted()
  if (typeof data.key !== 'string' || !data.key.trim()) throw new Error('OpenRouter returned no API key. Start Sign in again.')
  return { accessToken: data.key, expiresAt: 0, ...(typeof data.user_id === 'string' && data.user_id ? { meta: { accountId: data.user_id } } : {}) }
}
