import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

/*
 * Fixture only: a local OAuth authorization server plus an MCP server that
 * accepts only its bearer tokens. It proves Anticode's side of the flow
 * (discovery, registration, PKCE, refresh, accounts, tools), not that any
 * real provider grants access.
 */

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-plugins-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { writeText: () => undefined },
  // The "browser": follows the authorize redirect back to the loopback callback.
  shell: { openExternal: async (url: string) => { await fetch(url) } }
}))
vi.mock('../secrets', () => ({ seal: (value: string) => `sealed:${value}`, unseal: (value: string) => value.replace(/^sealed:/, '') }))

const { listPlugins, pluginAction, pluginTools, pluginSecrets, closePlugins } = await import('./index')
const { discover, jwtIdentity, needsRefresh } = await import('./oauth')

const fixture = { user: 'ana@example.com', registered: [] as string[], refreshed: 0, codes: new Map<string, { challenge: string; user: string }>(), tokens: new Map<string, string>() }
let server: Server
let base = ''

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base)
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return send(200, { resource: `${base}/mcp`, authorization_servers: [base] })
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return send(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` })
      }
      if (url.pathname === '/register') {
        const client = JSON.parse(body) as { client_name: string; redirect_uris: string[]; token_endpoint_auth_method: string }
        fixture.registered.push(`${client.client_name}|${client.token_endpoint_auth_method}|${client.redirect_uris[0]}`)
        return send(201, { client_id: `client-${fixture.registered.length}` })
      }
      if (url.pathname === '/authorize') {
        const params = url.searchParams
        if (params.get('code_challenge_method') !== 'S256' || params.get('resource') !== `${base}/mcp`) return send(400, { error: 'invalid_request' })
        const code = `code-${fixture.codes.size + 1}`
        fixture.codes.set(code, { challenge: params.get('code_challenge') ?? '', user: fixture.user })
        res.writeHead(302, { location: `${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}` }).end()
        return
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body)
        let user: string | undefined
        if (form.get('grant_type') === 'authorization_code') {
          const issued = fixture.codes.get(form.get('code') ?? '')
          const verifier = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
          if (issued === undefined || issued.challenge !== verifier) return send(400, { error: 'invalid_grant' })
          user = issued.user
        } else {
          user = fixture.tokens.get(form.get('refresh_token') ?? '')
          fixture.refreshed += 1
        }
        if (user === undefined) return send(400, { error: 'invalid_grant' })
        const access = jwt({ email: user, n: Math.random() })
        const refresh = `rt-${Math.random()}`
        fixture.tokens.set(access, user)
        fixture.tokens.set(refresh, user)
        // Expires within the renewal window, so the next request refreshes.
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 30, token_type: 'Bearer' })
      }
      if (url.pathname === '/mcp') {
        const user = fixture.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
        if (user === undefined) {
          return send(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
        }
        const message = JSON.parse(body) as { id?: number; method: string }
        if (message.id === undefined) { res.writeHead(202).end(); return }
        const result =
          message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
            : message.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'Who is signed in', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
              : { content: [{ type: 'text', text: user }] }
        return send(200, { jsonrpc: '2.0', id: message.id, result })
      }
      send(404, {})
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await closePlugins()
  server.close()
})

async function whoami(): Promise<string> {
  const tool = pluginTools().find((candidate) => candidate.name === 'plugin__Fixture__whoami')
  if (tool === undefined) throw new Error('whoami not offered')
  const call = tool.prepare({})
  expect(call.risk).toBe('low')
  return (await call.execute({ workspaceRoot: userData, signal: new AbortController().signal })).text
}

it('discovers OAuth metadata the way the MCP spec places it', async () => {
  const found = await discover(`${base}/mcp`)
  expect(found.resource).toBe(`${base}/mcp`)
  expect(found.meta.registration_endpoint).toBe(`${base}/register`)
  expect(jwtIdentity(jwt({ email: 'x@y.z' }))).toBe('x@y.z')
  expect(needsRefresh({ accessToken: 't', expiresAt: 0 })).toBe(false)
})

it('signs in several accounts, switches between them and keeps one slot per identity', async () => {
  let view = await pluginAction({ type: 'add-custom', name: 'Fixture', url: `${base}/mcp` })
  const id = view.plugins.find((plugin) => plugin.name === 'Fixture')!.id
  expect(view.plugins.some((plugin) => plugin.id === 'github' && plugin.auth === 'github')).toBe(true)

  view = await pluginAction({ type: 'login', plugin: id })
  expect(fixture.registered[0]).toMatch(/^Anticode\|none\|http:\/\/127\.0\.0\.1:\d+\/callback$/)
  let plugin = view.plugins.find((entry) => entry.id === id)!
  expect(plugin.state).toBe('ready')
  expect(plugin.accounts.map((account) => account.label)).toEqual(['ana@example.com'])
  const tool = pluginTools().find((candidate) => candidate.name === 'plugin__Fixture__whoami')!
  expect(tool.connector).toBe('Fixture plugin')
  expect(await whoami()).toBe('ana@example.com')
  expect(fixture.refreshed).toBeGreaterThan(0)

  fixture.user = 'budi@example.com'
  view = await pluginAction({ type: 'login', plugin: id })
  plugin = view.plugins.find((entry) => entry.id === id)!
  expect(plugin.accounts.map((account) => account.label)).toEqual(['ana@example.com', 'budi@example.com'])
  expect(plugin.activeAccount).toBe(plugin.accounts[1]!.id)
  expect(await whoami()).toBe('budi@example.com')

  view = await pluginAction({ type: 'select', plugin: id, account: plugin.accounts[0]!.id })
  expect(await whoami()).toBe('ana@example.com')

  // Signing in as Ana again renews her account rather than adding a slot.
  fixture.user = 'ana@example.com'
  view = await pluginAction({ type: 'login', plugin: id })
  expect(view.plugins.find((entry) => entry.id === id)!.accounts).toHaveLength(2)

  // Tokens are sealed on disk and offered for masking in exports.
  const disk = readFileSync(path.join(userData, 'plugins.json'), 'utf8')
  expect(disk).toContain('sealed:')
  expect(pluginSecrets().length).toBeGreaterThan(0)

  view = await pluginAction({ type: 'enable', plugin: id, enabled: false })
  expect(view.plugins.find((entry) => entry.id === id)!.state).toBe('off')
  expect(pluginTools()).toHaveLength(0)
  expect(listPlugins().login).toBeNull()
})

it('rejects bad input at the IPC boundary', async () => {
  await expect(pluginAction({ type: 'add-custom', name: 'Plain', url: 'http://example.com/mcp' })).rejects.toThrow(/https/)
  await expect(pluginAction({ type: 'login', plugin: 'nope' })).rejects.toThrow(/Unknown plugin/)
  await expect(pluginAction({ type: 'github-client', clientId: 'bad id!' })).rejects.toThrow(/client ID/)
  await expect(pluginAction({ type: 'login', plugin: 'github' })).rejects.toThrow(/client ID/)
})
