import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { makeVerifier, makeChallenge } from './pkce'
import type { AuthLoginCallbacks, AuthTokens } from './types'
import { cursorCommand } from '../providers/cursorCli'

export async function loginCursor(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  await cursorCommand()
  const verifier = makeVerifier()
  const uuid = randomUUID()
  const url = new URL('https://cursor.com/loginDeepControl')
  url.searchParams.set('challenge', makeChallenge(verifier))
  url.searchParams.set('uuid', uuid)
  url.searchParams.set('mode', 'login')
  url.searchParams.set('redirectTarget', 'cli')
  callbacks.onUpdate({ message: 'Authorize Cursor in your browser', url: url.href })
  await shell.openExternal(url.href)
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    callbacks.signal.throwIfAborted()
    const poll = new URL('https://api2.cursor.sh/auth/poll')
    poll.searchParams.set('uuid', uuid)
    poll.searchParams.set('verifier', verifier)
    const response = await fetch(poll, { signal: callbacks.signal })
    if (response.status === 403) throw new Error('Cursor authorization denied. Check your organization sign-in policy.')
    if (response.ok) {
      const body = await response.json() as { accessToken?: string; refreshToken?: string }
      if (body.accessToken && body.refreshToken) {
        callbacks.onUpdate({ message: 'Signed in', done: true })
        return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresAt: tokenExpiry(body.accessToken), meta: { account: cursorIdentity(body.accessToken) } }
      }
    } else if (![404, 408, 429].includes(response.status)) throw new Error(`Cursor authorization failed (${response.status})`)
    await sleep(response.status === 429 ? 5000 : 1500, undefined, { signal: callbacks.signal })
  }
  throw new Error('Cursor authorization expired. Sign in again.')
}

function claims(token: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown> } catch { return {} }
}
export function tokenExpiry(token: string): number { const exp = claims(token).exp; return typeof exp === 'number' ? exp * 1000 : 0 }
function cursorIdentity(token: string): string {
  const body = claims(token)
  return typeof body.email === 'string' ? body.email : typeof body.sub === 'string' ? body.sub : 'Cursor'
}

// Cursor's refresh contract is not public. Never guess an endpoint or reuse a
// token on a different route: require browser authorization when it expires.
export function validCursorTokens(tokens: AuthTokens): AuthTokens {
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60_000) throw new Error('Cursor authorization expired. Sign in again in Settings → Auth provider.')
  return tokens
}
