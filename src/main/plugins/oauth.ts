import { makeChallenge, makeState, makeVerifier } from '../auth/pkce'
import { waitForCallback } from '../auth/server'

/*
 * OAuth for remote MCP servers, as the MCP authorization spec lays it out and
 * as Claude Desktop and Codex implement it (docs/research/plugins-oauth-2026-11-11.md):
 * protected-resource metadata → authorization-server metadata → dynamic client
 * registration under Anticode's own name → PKCE through a loopback redirect →
 * token, renewed with the refresh token. GitHub offers no registration, so it
 * takes the device flow with the user's own OAuth App client ID, or a token.
 */

export interface ServerMeta {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
}

/** What an account keeps to call the server and renew its access. */
export interface PluginTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms; 0 when the token does not expire. */
  expiresAt: number
  tokenEndpoint?: string
  clientId?: string
  clientSecret?: string
  resource?: string
  /** Who signed in, when the token tells: JWT email/sub, GitHub login. */
  identity?: string
}

type FetchFn = typeof fetch

const CLIENT_NAME = 'Anticode'
const TIMEOUT_MS = 15_000

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { /* reported below */ }
  if (!response.ok) {
    const detail = typeof body['error_description'] === 'string' ? body['error_description'] : typeof body['error'] === 'string' ? body['error'] : text.slice(0, 160)
    throw new Error(`${what}: HTTP ${response.status}${detail === '' ? '' : ` (${detail})`}`)
  }
  return body
}

async function getJson(url: string, fetchFn: FetchFn): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    return response.ok ? ((await response.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `/.well-known/<name>` inserted before the path, as RFC 8414/9728 place it. */
function wellKnown(base: string, name: string): string[] {
  const url = new URL(base)
  const path = url.pathname.replace(/\/+$/, '')
  return path === '' ? [`${url.origin}/.well-known/${name}`] : [`${url.origin}/.well-known/${name}${path}`, `${url.origin}/.well-known/${name}`]
}

/** Where the MCP server sends clients to sign in, and the scope it asks for. */
export async function discover(mcpUrl: string, fetchFn: FetchFn = fetch): Promise<{ resource: string; meta: ServerMeta; scope?: string }> {
  let metadataUrl: string | null = null
  let scope: string | undefined
  try {
    const probe = await fetchFn(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anticode', version: '0' } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const challenge = probe.headers.get('www-authenticate') ?? ''
    metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? null
    scope = /scope="([^"]+)"/.exec(challenge)?.[1]
    await probe.body?.cancel().catch(() => undefined)
  } catch {
    // Discovery below still has the well-known paths.
  }
  let resourceMeta: Record<string, unknown> | null = null
  for (const url of metadataUrl !== null ? [metadataUrl] : wellKnown(mcpUrl, 'oauth-protected-resource')) {
    resourceMeta = await getJson(url, fetchFn)
    if (resourceMeta !== null) break
  }
  const servers = resourceMeta?.['authorization_servers']
  // Servers on the 2025-03-26 spec have no resource metadata: the MCP origin is the issuer.
  const issuer = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : new URL(mcpUrl).origin
  const resource = typeof resourceMeta?.['resource'] === 'string' ? resourceMeta['resource'] : mcpUrl
  if (scope === undefined && Array.isArray(resourceMeta?.['scopes_supported'])) scope = (resourceMeta['scopes_supported'] as string[]).join(' ')
  for (const url of [...wellKnown(issuer, 'oauth-authorization-server'), ...wellKnown(issuer, 'openid-configuration')]) {
    const meta = await getJson(url, fetchFn)
    if (typeof meta?.['authorization_endpoint'] === 'string' && typeof meta['token_endpoint'] === 'string') {
      return { resource, meta: meta as unknown as ServerMeta, ...(scope !== undefined && scope !== '' ? { scope } : {}) }
    }
  }
  throw new Error(`${new URL(mcpUrl).host} does not publish OAuth sign-in metadata`)
}

/** Dynamic client registration (RFC 7591) as a public client under Anticode's own name. */
export async function registerClient(meta: ServerMeta, redirectUri: string, fetchFn: FetchFn = fetch): Promise<{ clientId: string; clientSecret?: string }> {
  if (meta.registration_endpoint === undefined) throw new Error('This server does not support dynamic client registration')
  const body = await json(await fetchFn(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  }), 'Client registration')
  if (typeof body['client_id'] !== 'string') throw new Error('Client registration returned no client_id')
  return { clientId: body['client_id'], ...(typeof body['client_secret'] === 'string' ? { clientSecret: body['client_secret'] } : {}) }
}

/** The email or subject inside a JWT, without trusting it for anything but a label. */
export function jwtIdentity(token: string | undefined): string | undefined {
  const part = token?.split('.')[1]
  if (part === undefined) return undefined
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
    for (const key of ['email', 'preferred_username', 'username', 'sub']) if (typeof claims[key] === 'string' && claims[key] !== '') return claims[key] as string
  } catch { /* not a JWT */ }
  return undefined
}

function tokensFrom(body: Record<string, unknown>, base: Omit<PluginTokens, 'accessToken' | 'expiresAt'>, now: number): PluginTokens {
  if (typeof body['access_token'] !== 'string' || body['access_token'] === '') throw new Error('The server returned no access token')
  const expiresIn = Number(body['expires_in'])
  const refreshToken = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : base.refreshToken
  const identity = jwtIdentity(typeof body['id_token'] === 'string' ? body['id_token'] : undefined) ?? jwtIdentity(body['access_token']) ?? base.identity
  return {
    ...base,
    accessToken: body['access_token'],
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(identity !== undefined ? { identity } : {})
  }
}

async function tokenRequest(endpoint: string, params: Record<string, string>, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  return json(await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  }), 'Token request')
}

export interface BrowserLoginOptions {
  mcpUrl: string
  openUrl: (url: string) => Promise<void> | void
  signal?: AbortSignal
  fetchFn?: FetchFn
  /** Fixed ports for tests; one free port is picked otherwise. */
  ports?: number[]
}

/** The whole browser sign-in for one MCP server. */
export async function browserLogin(options: BrowserLoginOptions): Promise<PluginTokens> {
  const fetchFn = options.fetchFn ?? fetch
  const { resource, meta, scope } = await discover(options.mcpUrl, fetchFn)
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 5 * 60_000)
  let port: (value: number) => void = () => undefined
  const listening = new Promise<number>((resolve) => { port = resolve })
  const callback = waitForCallback({ ports: options.ports ?? [0], path: '/callback', signal: controller.signal, onListening: (bound) => port(bound) })
  try {
    const redirectUri = `http://127.0.0.1:${await Promise.race([listening, callback.then(() => 0)])}/callback`
    const client = await registerClient(meta, redirectUri, fetchFn)
    const verifier = makeVerifier()
    const state = makeState()
    const authorize = new URL(meta.authorization_endpoint)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', client.clientId)
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('code_challenge', makeChallenge(verifier))
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('state', state)
    authorize.searchParams.set('resource', resource)
    if (scope !== undefined) authorize.searchParams.set('scope', scope)
    await options.openUrl(authorize.href)
    const result = await callback
    if (result.error !== undefined) throw new Error(`Sign-in was refused: ${result.error}`)
    if (result.state !== state) throw new Error('Sign-in answered with a different state; try again')
    const body = await tokenRequest(meta.token_endpoint, {
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource,
      ...(client.clientSecret !== undefined ? { client_secret: client.clientSecret } : {})
    }, fetchFn)
    return tokensFrom(body, { tokenEndpoint: meta.token_endpoint, clientId: client.clientId, resource, ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}) }, Date.now())
  } catch (error) {
    controller.abort()
    await callback.catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** True when the token should be renewed before the next request. */
export function needsRefresh(tokens: PluginTokens, now = Date.now()): boolean {
  return tokens.expiresAt !== 0 && tokens.expiresAt - 60_000 <= now
}

export async function refreshTokens(tokens: PluginTokens, fetchFn: FetchFn = fetch): Promise<PluginTokens> {
  if (tokens.refreshToken === undefined || tokens.tokenEndpoint === undefined || tokens.clientId === undefined) {
    throw new Error('The sign-in expired; sign in again')
  }
  const body = await tokenRequest(tokens.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
    ...(tokens.resource !== undefined ? { resource: tokens.resource } : {}),
    ...(tokens.clientSecret !== undefined ? { client_secret: tokens.clientSecret } : {})
  }, fetchFn)
  return tokensFrom(body, { ...tokens }, Date.now())
}

export const GITHUB_SCOPES = 'repo read:org read:user workflow'

/** The GitHub login a token belongs to; rejects tokens GitHub does not accept. */
export async function githubIdentity(token: string, fetchFn: FetchFn = fetch): Promise<string> {
  const body = await json(await fetchFn('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'anticode' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  }), 'GitHub token check')
  if (typeof body['login'] !== 'string') throw new Error('GitHub did not say whose token this is')
  return body['login']
}

export interface DeviceCode { userCode: string; verificationUri: string }

/** GitHub device flow with the user's own OAuth App client ID; no secret or redirect needed. */
export async function githubDeviceLogin(
  clientId: string,
  onCode: (code: DeviceCode) => Promise<void> | void,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<PluginTokens> {
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'anticode' }
  const device = await json(await fetchFn('https://github.com/login/device/code', {
    method: 'POST', headers, body: JSON.stringify({ client_id: clientId, scope: GITHUB_SCOPES }), signal: signal ?? AbortSignal.timeout(TIMEOUT_MS)
  }), 'GitHub device code')
  if (typeof device['device_code'] !== 'string' || typeof device['user_code'] !== 'string') {
    throw new Error('GitHub refused the device flow; enable “Device Flow” on the OAuth App')
  }
  await onCode({ userCode: device['user_code'], verificationUri: typeof device['verification_uri'] === 'string' ? device['verification_uri'] : 'https://github.com/login/device' })
  let interval = Math.max(1, Number(device['interval']) || 5) * 1000
  const deadline = Date.now() + (Number(device['expires_in']) || 900) * 1000
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Login cancelled')
    await sleep(interval)
    const body = (await (await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST', headers,
      body: JSON.stringify({ client_id: clientId, device_code: device['device_code'], grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    })).json()) as Record<string, unknown>
    if (typeof body['access_token'] === 'string') {
      const tokens = tokensFrom(body, { tokenEndpoint: 'https://github.com/login/oauth/access_token', clientId }, Date.now())
      return { ...tokens, identity: await githubIdentity(tokens.accessToken, fetchFn) }
    }
    if (body['error'] === 'slow_down') interval += 5000
    else if (body['error'] !== 'authorization_pending') throw new Error(`GitHub sign-in failed: ${String(body['error_description'] ?? body['error'] ?? 'unknown error')}`)
  }
  throw new Error('The GitHub code expired; start the sign-in again')
}
