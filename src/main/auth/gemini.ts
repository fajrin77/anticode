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
 * Two facts about this endpoint shape the code below. A consumer account gets
 * 403 from the catalogue route (`fetchAvailableModels` is for Code Assist
 * licences), so the model list comes from the Gemini CLI's own table; and a
 * plan that was never assigned a project needs `onboardUser` once, which the
 * CLI performs on first run. Only what the plan assigns is used: no project is
 * created here and no turn is rerouted to a paid key.
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

/**
 * The chat models the Gemini CLI offers, with the names it gives them. These
 * are its own ids (`packages/core/src/config/models.js`), plus the two aliases
 * a person recognises from the Gemini app menu. A model is only run if the
 * plan accepts it; the endpoint answers for itself when it does not.
 */
export const GEMINI_MODELS: { id: string; name: string }[] = [
  // Gemini 4 series, ids and 1M context from ai.google.dev/docs/models.
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon' },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { id: 'gemini-3.8-flash-lite', name: 'Gemini 3.8 Flash Lite' },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
  { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite Preview' },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
  { id: 'gemma-4-31b-it', name: 'Gemma 4 31B' },
  { id: 'gemma-4-26b-a4b-it', name: 'Gemma 4 26B A4B' },
  { id: 'flash-lite', name: 'Flash Lite (alias)' },
  { id: 'flash', name: 'Flash (alias)' },
  { id: 'pro', name: 'Pro (alias)' }
]

export function geminiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': `anticode-gemini-adapter (${process.platform}; ${process.arch})`,
    'X-Goog-Api-Client': 'gl-node/22.19.0'
  }
}

async function callAssistant<T>(token: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${GEMINI_CLOUD_BASE}/v1internal:${method}`, {
    method: 'POST',
    headers: geminiHeaders(token),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20_000)
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
    throw Object.assign(new Error(`${method} failed (${response.status})${detail ? `: ${detail}` : ''}`), { status: response.status })
  }
  return await response.json() as T
}

interface Tier { id?: string; name?: string; isDefault?: boolean; hasOnboardedPreviously?: boolean }
interface CodeAssist {
  cloudaicompanionProject?: string | { id?: string }
  currentTier?: Tier
  paidTier?: Tier
  allowedTiers?: Tier[]
}
interface Operation { done?: boolean; name?: string; response?: { cloudaicompanionProject?: { id?: string } } }

/** The plan's managed project, when Google assigned one. It is never created here. */
function projectOf(data: CodeAssist | undefined): string | undefined {
  const project = typeof data?.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data?.cloudaicompanionProject?.id
  return project === '' ? undefined : project
}

async function loadCodeAssist(token: string, signal?: AbortSignal): Promise<CodeAssist | undefined> {
  try { return await callAssistant<CodeAssist>(token, 'loadCodeAssist', { metadata: CLIENT_METADATA }, signal) } catch { return undefined }
}

/**
 * The first run of the CLI on a plan that has no project yet: the endpoint
 * onboards the account for the tier it offers, and answers with the managed
 * project. The project stays Google's, not a Cloud project of this app's.
 */
async function onboard(token: string, tier: Tier | undefined, signal?: AbortSignal): Promise<string | undefined> {
  if (!tier?.id) return undefined
  const request = { tierId: tier.id, cloudaicompanionProject: undefined, metadata: CLIENT_METADATA }
  let operation = await callAssistant<Operation>(token, 'onboardUser', request, signal).catch(() => undefined)
  for (let attempt = 0; operation !== undefined && !operation.done && attempt < 12; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Login cancelled')); return }
      const onAbort = (): void => { clearTimeout(timer); reject(new Error('Login cancelled')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 5_000)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    operation = await callAssistant<Operation>(token, 'onboardUser', request, signal).catch(() => undefined)
  }
  return operation?.response?.cloudaicompanionProject?.id
}

/** Project and plan for a signed-in account, onboarding once when needed. */
export async function geminiPlanInfo(token: string, signal?: AbortSignal): Promise<{ project?: string; tier?: string }> {
  const data = await loadCodeAssist(token, signal)
  const tier = data?.paidTier ?? data?.currentTier
  const assigned = projectOf(data)
  if (assigned) return { project: assigned, ...(tier?.name ?? tier?.id ? { tier: tier?.name ?? tier?.id } : {}) }
  // No managed project yet: onboard once for the active or default offered tier.
  const offered = tier ?? data?.allowedTiers?.find((entry) => entry.isDefault) ?? data?.allowedTiers?.[0]
  const created = await onboard(token, offered, signal)
  return { ...(created ? { project: created } : {}), ...(offered?.name ?? offered?.id ? { tier: offered?.name ?? offered?.id } : {}) }
}

export async function geminiProject(token: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await geminiPlanInfo(token, signal)).project
}

/** What the account's plan is called, for the Usage panel. */
export async function geminiPlan(token: string, signal?: AbortSignal): Promise<string | undefined> {
  return (await geminiPlanInfo(token, signal)).tier
}

async function exchange(body: URLSearchParams, signal?: AbortSignal): Promise<AuthTokens> {
  const client = geminiOAuthClient()
  body.set('client_id', client.id)
  body.set('client_secret', client.secret)
  const timeout = AbortSignal.timeout(20_000)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw Object.assign(new Error(`Gemini token exchange failed (${response.status}). Sign in again.`), { status: response.status })
  const data = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('Gemini token response is missing an access token')
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  }
}

export async function loginGemini(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const client = geminiOAuthClient()
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
          client_id: client.id,
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
    const plan = await geminiPlanInfo(tokens.accessToken, signal)
    tokens.meta = { account: user.email ?? 'Gemini', ...(plan.project ? { project: plan.project } : {}), ...(plan.tier ? { plan: plan.tier } : {}) }
    callbacks.onUpdate({ message: `Signed in${plan.tier ? ` · ${plan.tier}` : ''}`, done: true })
    return tokens
  } finally { controller.abort() }
}

export async function refreshGemini(tokens: AuthTokens): Promise<AuthTokens> {
  if (!tokens.refreshToken) throw new Error('Gemini has no refresh token. Sign in again.')
  const renewed = await exchange(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }))
  return { ...tokens, ...renewed, meta: { ...tokens.meta, ...renewed.meta } }
}

/**
 * The models this account can pick from. Consumer plans answer 403 on the
 * Code Assist catalogue route, so the CLI's table is the list; whatever the
 * endpoint does report, when it does, is merged in front of it. A family
 * newer than the CLI's table can also be listed using its published API id.
 * Published API availability is not proof of subscription access: the plan's
 * response still decides whether a listed model runs.
 */
export async function geminiModels(tokens: AuthTokens): Promise<string[]> {
  const project = tokens.meta?.project ?? await geminiProject(tokens.accessToken)
  let reported: string[] = []
  try {
    const data = await callAssistant<{ models?: Record<string, { disabled?: boolean } | undefined> }>(
      tokens.accessToken,
      'fetchAvailableModels',
      project ? { project } : {}
    )
    reported = Object.entries(data.models ?? {})
      .filter(([id, value]) => id.includes('gemini') && !id.includes('embedding') && value?.disabled !== true)
      .map(([id]) => id)
  } catch { /* A plan without the Code Assist licence keeps the CLI's list. */ }
  const ids = [...new Set([...reported, ...GEMINI_MODELS.map((model) => model.id)])]
  return ids.sort((a, b) => a.localeCompare(b))
}
