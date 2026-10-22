import { shell } from 'electron'
import { APP_VERSION } from '../version'
import type { AuthLoginCallbacks, AuthTokens } from './types'
const BASE = 'https://api.kilo.ai/api/device-auth/codes'

export async function loginKilo(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const signal = AbortSignal.any([callbacks.signal, AbortSignal.timeout(5 * 60_000)])
  const headers = { 'content-type': 'application/json', 'user-agent': `anticode/${APP_VERSION}` }
  const start = await fetch(BASE, { method: 'POST', headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
  if (!start.ok) throw new Error(`Kilo could not start device login (HTTP ${start.status}).`)
  const data = await start.json() as { code?: unknown; verificationUrl?: unknown; expiresIn?: number }
  if (typeof data.code !== 'string' || !data.code || typeof data.verificationUrl !== 'string') throw new Error('Kilo returned an incomplete device login.')
  const url = new URL(data.verificationUrl)
  if (url.protocol !== 'https:' || !['kilo.ai', 'app.kilo.ai', 'api.kilo.ai'].includes(url.hostname)) throw new Error('Kilo returned an unrecognized authorization website.')
  callbacks.onUpdate({ message: 'Approve Kilo access in your browser. Anticode uses free model routes only.', url: url.toString() })
  void shell.openExternal(url.toString())
  const deadline = Date.now() + Math.min(300, Math.max(1, typeof data.expiresIn === 'number' ? data.expiresIn : 300)) * 1000
  let interval = 3000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const response = await fetch(`${BASE}/${encodeURIComponent(data.code)}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    if (response.status === 403) throw new Error('Kilo authorization was declined.')
    if (response.status === 410) throw new Error('Kilo authorization expired. Start Sign in again.')
    if (response.status === 429) interval = Math.min(interval + 2000, 15000)
    else if (response.status !== 202) {
      if (!response.ok) throw new Error(`Kilo login polling failed (HTTP ${response.status}).`)
      const result = await response.json() as { status?: string; token?: unknown; userEmail?: unknown }
      if (result.status === 'approved' && typeof result.token === 'string' && result.token.trim()) {
        signal.throwIfAborted()
        const email = typeof result.userEmail === 'string' ? result.userEmail : ''
        return { accessToken: result.token, expiresAt: 0, ...(email ? { meta: { email } } : {}) }
      }
      if (result.status === 'denied') throw new Error('Kilo authorization was declined.')
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(new Error('Kilo login cancelled')) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, Math.min(interval, Math.max(1, deadline - Date.now())))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  throw new Error('Kilo authorization expired. Start Sign in again.')
}
