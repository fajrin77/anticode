import { shell } from 'electron'
import { APP_VERSION } from '../version'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/** Vercel AI Gateway: OpenAI-compatible, one key for every model it fronts. */
export const VERCEL_GATEWAY_BASE = 'https://ai-gateway.vercel.sh/v1'
const KEYS_PAGE = 'https://vercel.com/dashboard/ai-gateway/api-keys'

/**
 * The gateway has no browser device flow, so login is a paste-key step: the
 * key comes from the Vercel dashboard, is checked against /models, then sealed
 * like every other account token. A key never renews; signing in replaces it.
 */
export async function loginVercel(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  callbacks.onUpdate({ message: 'Opening the Vercel AI Gateway key page…', url: KEYS_PAGE, needsCode: true })
  await shell.openExternal(KEYS_PAGE)

  const pasted = (await callbacks.promptForCode('Paste the Vercel AI Gateway API key:'))?.trim() ?? ''
  if (pasted === '') throw new Error('A Vercel AI Gateway key is required. Create one in the Vercel dashboard and paste it here.')
  if (!/^[A-Za-z0-9._\-]{16,}$/.test(pasted)) throw new Error('That does not look like a Vercel AI Gateway key.')

  callbacks.onUpdate({ message: 'Checking the key with the gateway…' })
  let response: Response
  try {
    response = await fetch(`${VERCEL_GATEWAY_BASE}/models`, {
      headers: { authorization: `Bearer ${pasted}`, accept: 'application/json', 'user-agent': `anticode/${APP_VERSION}` },
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new Error('The Vercel AI Gateway could not be reached. Check the connection and try again.')
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('Vercel rejected this key. Create a new AI Gateway key and paste it again.')
  }
  if (!response.ok) throw new Error(`The Vercel AI Gateway answered ${response.status}. Try signing in again later.`)

  // expiresAt 0 marks a token that cannot renew, so the panel says to sign in
  // again rather than trying a refresh the gateway does not offer.
  callbacks.onUpdate({ message: 'Signed in', done: true })
  return { accessToken: pasted, expiresAt: 0, meta: { account: 'Vercel AI Gateway' } }
}
