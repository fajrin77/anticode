import { shell } from 'electron'
import { makeVerifier, makeChallenge, makeState } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

function oauthClient(): { id: string; secret: string } {
  const id = process.env.ANTICODE_ANTIGRAVITY_CLIENT_ID?.trim()
  const secret = process.env.ANTICODE_ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (!id || !secret) throw new Error('Antigravity OAuth client is not configured. Set ANTICODE_ANTIGRAVITY_CLIENT_ID and ANTICODE_ANTIGRAVITY_CLIENT_SECRET, then restart Anticode. Account authorization still happens in your browser.')
  return { id, secret }
}
const REDIRECT = 'http://localhost:51121/oauth-callback'
export const ANTIGRAVITY_BASE = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const metadata = { ideType: 'ANTIGRAVITY' }

export function antigravityHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': `anticode-antigravity-adapter (${process.platform}; ${process.arch})` }
}
async function exchange(body: URLSearchParams, signal?: AbortSignal): Promise<AuthTokens> {
  const client = oauthClient()
  body.set('client_id', client.id); body.set('client_secret', client.secret)
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, signal: signal ?? AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Antigravity token exchange failed (${response.status}). Sign in again.`)
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Antigravity token response is missing an access token')
  return { accessToken: data.access_token, ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}), expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 }
}
export async function antigravityProject(token: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${ANTIGRAVITY_BASE}/v1internal:loadCodeAssist`, { method: 'POST', headers: antigravityHeaders(token), body: JSON.stringify({ metadata }), signal: signal ?? AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Antigravity project unavailable (${response.status})`)
  const data = await response.json() as { cloudaicompanionProject?: string | { id?: string } }
  const project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id
  if (!project) throw new Error('Activate Antigravity in the official app first. No managed project is assigned; Anticode will not create a billable Cloud project.')
  return project
}
export async function loginAntigravity(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const CLIENT_ID = oauthClient().id
  const verifier = makeVerifier(), state = makeState()
  const controller = new AbortController()
  const signal = AbortSignal.any([callbacks.signal, controller.signal, AbortSignal.timeout(5 * 60_000)])
  try {
    const result = await waitForCallback({ ports: [51121], path: '/oauth-callback', signal, onListening: () => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
      for (const [key, value] of Object.entries({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs', state, code_challenge: makeChallenge(verifier), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) url.searchParams.set(key, value)
      callbacks.onUpdate({ message: 'Authorize Antigravity with Google in your browser', url: url.href })
      void shell.openExternal(url.href).catch(() => controller.abort())
    } })
    if (result.error || result.state !== state || !result.code) throw new Error('Antigravity authorization rejected or state mismatch')
    const tokens = await exchange(new URLSearchParams({ grant_type: 'authorization_code', code: result.code, redirect_uri: REDIRECT, code_verifier: verifier }), signal)
    const project = await antigravityProject(tokens.accessToken, signal)
    const identity = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal })
    if (!identity.ok) throw new Error(`Google identity lookup failed (${identity.status})`)
    const user = await identity.json() as { email?: string }
    tokens.meta = { account: user.email ?? 'Antigravity', project }
    callbacks.onUpdate({ message: 'Signed in', done: true })
    return tokens
  } finally { controller.abort() }
}
export async function refreshAntigravity(tokens: AuthTokens): Promise<AuthTokens> {
  if (!tokens.refreshToken) throw new Error('Antigravity has no refresh token. Sign in again.')
  return { ...tokens, ...await exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })) }
}
export async function antigravityModels(tokens: AuthTokens): Promise<string[]> {
  const project = tokens.meta?.project ?? await antigravityProject(tokens.accessToken)
  const response = await fetch(`${ANTIGRAVITY_BASE}/v1internal:fetchAvailableModels`, { method: 'POST', headers: antigravityHeaders(tokens.accessToken), body: JSON.stringify({ project }), signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Antigravity models unavailable (${response.status})`)
  const data = await response.json() as { models?: Record<string, { disabled?: boolean }> }
  const models = Object.entries(data.models ?? {}).filter(([id, value]) => id.startsWith('gemini-') && !value.disabled).map(([id]) => id)
  if (!models.length) throw new Error('No supported Gemini models reported by this Antigravity account')
  return models
}
