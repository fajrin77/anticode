import { shell } from 'electron'
import { geminiOAuthClient } from './antigravityClient'
import { makeChallenge, makeState, makeVerifier } from './pkce'
import { waitForCallback } from './server'
import type { AuthLoginCallbacks, AuthTokens } from './types'

/*
 * A Gemini app subscription (Google AI Plus/Pro) used the way the Gemini CLI
 * uses it: Google browser sign-in, then Google's own Cloud Code endpoint with
 * the account's plan. No API key, no billable Cloud project of our own.
 *
 * The plan is the account's, so nothing here invents extra access: the model
 * list comes from the account, and a turn the plan refuses fails as that plan
 * refuses it rather than falling back to a paid key.
 */

export const GEMINI_CLOUD_BASE = 'https://cloudcode-pa.googleapis.com'
const REDIRECT = 'http://localhost:8085/oauth-callback'
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ')
/** What the endpoint is told about the client; the CLI sends the same shape. */
const CLIENT_METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }

export function geminiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `anticode-gemini-adapter (${process.platform}; ${process.arch})`,
    'X-Goog-Api-Client': 'gl-node/22.19.0'
  }
}

async function exchange(body: URLSearchParams, signal?: AbortSignal): Promise<AuthTokens> {
  const client = geminiOAuthClient()
  body.set('client_id', client.id)
  body.set('client_secret', client.secret)
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body, signal: signal ?? AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Gemini token exchange failed (${response.status}). Sign in again.`)
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Gemini token response is missing an access token')
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  }
}

interface CodeAssist {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: { id?: string; name?: string }
  allowedTiers?: { id?: string; name?: string; isDefault?: boolean }[]
}

async function loadCodeAssist(token: string, signal?: AbortSignal): Promise<CodeAssist | undefined> {
  try {
    const response = await fetch(`${GEMINI_CLOUD_BASE}/v1internal:loadCodeAssist`, {
      method: 'POST',
      headers: geminiHeaders(token),
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      signal: signal ?? AbortSignal.timeout(20_000)
    })
    return response.ok ? await response.json() as CodeAssist : undefined
  } catch { return undefined }
}

/** The plan's managed project, when Google assigned one. It is never created here. */
function projectOf(data: CodeAssist | undefined): string | undefined {
  const project = typeof data?.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data?.cloudaicompanionProject?.id
  return project === '' ? undefined : project
}

export async function geminiProject(token: string, signal?: AbortSignal): Promise<string | undefined> {
  return projectOf(await loadCodeAssist(token, signal))
}

/** What the account's plan is called, for the Usage panel. */
export async function geminiPlan(token: string, signal?: AbortSignal): Promise<string | undefined> {
  const data = await loadCodeAssist(token, signal)
  return data?.currentTier?.name ?? data?.currentTier?.id
}

export async function loginGemini(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const CLIENT_ID = geminiOAuthClient().id
  const verifier = makeVerifier()
  const state = makeState()
  const controller = new AbortController()
  const signal = AbortSignal.any([callbacks.signal, controller.signal, AbortSignal.timeout(5 * 60_000)])
  try {
    const result = await waitForCallback({
      ports: [8085],
      path: '/oauth-callback',
      signal,
      onListening: () => {
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        for (const [key, value] of Object.entries({
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          response_type: 'code',
          scope: SCOPES,
          state,
          code_challenge: makeChallenge(verifier),
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent'
        })) url.searchParams.set(key, value)
        callbacks.onUpdate({ message: 'Sign in to the Google account that holds your Gemini plan', url: url.href })
        void shell.openExternal(url.href).catch(() => controller.abort())
      }
    })
    if (result.error || result.state !== state || !result.code) throw new Error('Gemini authorization rejected or state mismatch')
    const tokens = await exchange(new URLSearchParams({ grant_type: 'authorization_code', code: result.code, redirect_uri: REDIRECT, code_verifier: verifier }), signal)
    const identity = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal })
    if (!identity.ok) throw new Error(`Google identity lookup failed (${identity.status})`)
    const user = await identity.json() as { email?: string }
    const project = await geminiProject(tokens.accessToken, signal)
    tokens.meta = { account: user.email ?? 'Gemini', ...(project ? { project } : {}) }
    callbacks.onUpdate({ message: 'Signed in', done: true })
    return tokens
  } finally { controller.abort() }
}

export async function refreshGemini(tokens: AuthTokens): Promise<AuthTokens> {
  if (!tokens.refreshToken) throw new Error('Gemini has no refresh token. Sign in again.')
  const renewed = await exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }))
  return { ...tokens, ...renewed, meta: { ...tokens.meta, ...renewed.meta } }
}

/**
 * The models this plan may run. Gemini's own list also carries embeddings and
 * internal routes; only the chat families Anticode can drive are kept.
 */
export async function geminiModels(tokens: AuthTokens): Promise<string[]> {
  const project = tokens.meta?.project ?? await geminiProject(tokens.accessToken)
  const response = await fetch(`${GEMINI_CLOUD_BASE}/v1internal:fetchAvailableModels`, {
    method: 'POST',
    headers: geminiHeaders(tokens.accessToken),
    body: JSON.stringify(project ? { project } : {}),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Gemini models unavailable (${response.status})`)
  const data = await response.json() as { models?: Record<string, { disabled?: boolean } | undefined> }
  const models = Object.entries(data.models ?? {})
    .filter(([id, value]) => id.startsWith('gemini-') && !id.includes('embedding') && value?.disabled !== true)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b))
  if (!models.length) throw new Error('This Gemini plan reported no usable Gemini models')
  return models
}
