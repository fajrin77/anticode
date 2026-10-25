import { shell } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AuthLoginCallbacks, AuthTokens } from './types'

// Public OAuth application identifier used by OpenCode (not a client secret).
const CLIENT_ID = 'Ov23li8tweQw6odWQebz'
export const COPILOT_BASE = 'https://api.githubcopilot.com'
export const COPILOT_HEADERS = { 'User-Agent': 'anticode', 'Openai-Intent': 'conversation-agent', 'X-Initiator': 'user' }

export async function loginCopilot(callbacks: AuthLoginCallbacks): Promise<AuthTokens> {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST', headers, body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }), signal: callbacks.signal
  })
  if (!response.ok) throw new Error(`GitHub device authorization failed (${response.status})`)
  const device = await response.json() as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number }
  if (!device.device_code || !device.user_code || device.verification_uri !== 'https://github.com/login/device') throw new Error('GitHub returned an invalid device authorization')
  callbacks.onUpdate({ message: `Authorize GitHub Copilot in your browser. Enter code: ${device.user_code}`, url: device.verification_uri })
  await shell.openExternal(device.verification_uri)
  const deadline = Date.now() + Math.min(device.expires_in ?? 900, 1800) * 1000
  let interval = Math.max(device.interval ?? 5, 5) * 1000
  while (Date.now() < deadline) {
    await sleep(interval, undefined, { signal: callbacks.signal })
    const poll = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers, signal: callbacks.signal,
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    })
    if (!poll.ok) throw new Error(`GitHub authorization polling failed (${poll.status})`)
    const token = await poll.json() as { access_token?: string; error?: string; interval?: number }
    if (token.error === 'authorization_pending') continue
    if (token.error === 'slow_down') { interval = Math.max(interval + 5000, (token.interval ?? 0) * 1000); continue }
    if (!token.access_token) throw new Error(`GitHub authorization failed: ${token.error ?? 'no token'}`)
    const user = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json' }, signal: callbacks.signal })
    if (!user.ok) throw new Error(`GitHub account lookup failed (${user.status})`)
    const identity = await user.json() as { login?: string }
    // Check subscription before storing; never silently switch to metered GitHub Models.
    await copilotModels(token.access_token, callbacks.signal)
    callbacks.onUpdate({ message: 'Signed in', done: true })
    return { accessToken: token.access_token, expiresAt: 0, meta: { account: identity.login ?? 'GitHub Copilot' } }
  }
  throw new Error('GitHub device authorization expired. Sign in again.')
}

export async function copilotModels(token: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${COPILOT_BASE}/models`, { headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${token}` }, signal: signal ?? AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`GitHub Copilot models unavailable (${response.status}); check your subscription and authorize the client`)
  const body = await response.json() as { data?: { id?: string; model_picker_enabled?: boolean; policy?: { state?: string }; supported_endpoints?: string[] }[] }
  const models = (body.data ?? []).filter((m) => m.id && m.model_picker_enabled !== false && m.policy?.state !== 'disabled' && m.supported_endpoints?.includes('/chat/completions')).map((m) => m.id!)
  if (!models.length) throw new Error('This Copilot account offers no supported chat-completions models')
  return [...new Set(models)]
}
