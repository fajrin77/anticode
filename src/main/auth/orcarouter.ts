import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/** OpenAI-compatible gateway that mirrors OpenRouter's wire format and sign-in. */
export const ORCAROUTER_BASE = 'https://api.orcarouter.ai/v1'
const ORCAROUTER_AUTHORIZE = 'https://www.orcarouter.ai/auth'
const ORCAROUTER_KEYS = 'https://api.orcarouter.ai/api/v1/auth/keys'

/** A pasted approval code, or the code inside the callback link the browser lands on. */
function pastedAuthorizationCode(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return null
  if (/^https?:/i.test(text)) {
    try {
      return new URL(text).searchParams.get('code')?.trim() || null
    } catch { return null }
  }
  if (text.startsWith('sk-') || /\s/.test(text)) return null
  return text
}

/*
 * OrcaRouter PKCE, the same shape as OpenRouter's: the browser is sent to a
 * localhost callback (loopback http is the only plain scheme the gateway
 * accepts) and the paste box stays open for a browser that shows the code
 * instead. The key that comes back is long-lived and never renews.
 */
export async function loginOrcaRouter(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const verifier = makeVerifier()
  const signal = AbortSignal.any([callbacks.signal, AbortSignal.timeout(10 * 60_000)])
  const callbackPath = `/orcarouter/${makeState()}`
  const local = new AbortController()
  const callback = waitForCallback({
    ports: [0],
    path: callbackPath,
    signal: AbortSignal.any([signal, local.signal]),
    onListening: (port) => {
      const url = new URL(ORCAROUTER_AUTHORIZE)
      url.searchParams.set('callback_url', `http://localhost:${port}${callbackPath}`)
      url.searchParams.set('code_challenge', makeChallenge(verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      callbacks.onUpdate({ message: 'Approve access in OrcaRouter; Anticode receives the code automatically.', url: url.toString() })
      void shell.openExternal(url.toString())
    }
  }).then(result => {
    if (result.error !== undefined) throw new Error(`OrcaRouter authorization was declined (${result.error}).`)
    return result.code
  })
  const code = await new Promise<string>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new Error('OrcaRouter login expired or was cancelled. Start Sign in again.')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    const settle = (value: string): void => { signal.removeEventListener('abort', abort); resolve(value) }
    const fail = (error: unknown): void => { if (!signal.aborted) { signal.removeEventListener('abort', abort); reject(error) } }
    callback.then(settle, fail)
    callbacks.promptForCode('If the browser shows a code, paste it here').then(settle, fail)
  }).finally(() => local.abort())
  signal.throwIfAborted()
  const grant = pastedAuthorizationCode(code)
  if (grant === null) throw new Error('Paste the single-use OrcaRouter authorization code, or the link the browser landed on; an API key and a dashboard URL are not an approval. Open the authorization link again to get a code.')
  const response = await fetch(ORCAROUTER_KEYS, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: grant, code_verifier: verifier, code_challenge_method: 'S256' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  })
  if (!response.ok) throw new Error(`OrcaRouter authorization exchange failed (HTTP ${response.status}). Start Sign in again for a fresh code.`)
  const data = await response.json() as { key?: unknown; user_id?: unknown }
  signal.throwIfAborted()
  if (typeof data.key !== 'string' || !data.key.trim()) throw new Error('OrcaRouter returned no API key. Start Sign in again.')
  return { accessToken: data.key, expiresAt: 0, ...(typeof data.user_id === 'string' && data.user_id ? { meta: { accountId: data.user_id } } : {}) }
}
