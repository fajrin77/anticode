import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }))
const stored = vi.hoisted(() => ({ accounts: [] as { id: string; kind: string }[] }))
const settings = vi.hoisted(() => ({ codex: true, claude: false }))
vi.mock('./connectorSettings', () => ({ getConnectorSettings: () => ({ ...settings }) }))
vi.mock('../auth/store', () => ({
  listAuthAccounts: () => stored.accounts,
  getAuthAccount: (id: string) => stored.accounts.find((account) => account.id === id)
}))
vi.mock('../auth/provider', () => ({ ensureFreshAuthTokens: async () => ({ accessToken: 't' }) }))

const { accountConnectorStatus, accountConnectorTools, chatgptConnectorOf, closeAccountConnectors, connectorKind, connectorRisk, CHATGPT_APPS_URL, CLAUDE_PROXY_URL } = await import('./accountConnectors')

afterEach(async () => {
  settings.codex = true
  settings.claude = false
  stored.accounts = []
  await closeAccountConnectors()
  vi.unstubAllGlobals()
})

it('does not contact claude.ai even when Claude accounts are stored', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  stored.accounts = [{ id: 'auth:claude', kind: 'claude' }]
  expect(accountConnectorTools('auth:claude')).toEqual([])
  expect(accountConnectorStatus('auth:claude')).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('only ChatGPT connectors are enabled; Claude inference is unaffected', () => {
  expect(connectorKind('codex')).toBe('codex')
  expect(connectorKind('claude')).toBeNull()
  for (const kind of ['cline', 'clinepass', 'kilo', 'codebuddy', 'openrouter', undefined]) expect(connectorKind(kind)).toBeNull()
})

it('groups ChatGPT apps by connector and leaves out ChatGPT internals', () => {
  expect(chatgptConnectorOf({ name: 'google_drive.update_file', meta: { connector_name: 'Google Drive' } })).toBe('Google Drive')
  expect(chatgptConnectorOf({ name: 'gmail.send_email' })).toBe('Gmail')
  expect(chatgptConnectorOf({ name: 'x.y', meta: { connector_name: 'Plugin Management' } })).toBeNull()
  expect(chatgptConnectorOf({ name: 'x.y', meta: { connector_name: 'Safety Settings' } })).toBeNull()
})

it('lets reads run, asks for writes, and always asks for destructive calls', () => {
  expect(connectorRisk({ annotations: { readOnlyHint: true } })).toBe('low')
  expect(connectorRisk({})).toBe('medium')
  expect(connectorRisk({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe('high')
})

it('offers nothing while no ChatGPT or Claude account is stored', () => {
  expect(accountConnectorTools(undefined)).toEqual([])
  expect(accountConnectorTools('openrouter')).toEqual([])
  expect(accountConnectorTools('auth:cline')).toEqual([])
  expect(CHATGPT_APPS_URL).toBe('https://chatgpt.com/backend-api/ps/mcp')
  expect(CLAUDE_PROXY_URL).toBe('https://mcp-proxy.anthropic.com/v1/mcp/')
})

it('reaches claude.ai connectors when enabled, then hides them when switched off', async () => {
  settings.claude = true
  const seen: { url: string; headers: Record<string, string> }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body?: string; method?: string }) => {
    seen.push({ url, headers: init.headers })
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.includes('/v1/mcp_servers')) return json({ data: [{ id: 'srv_1', display_name: 'Google Drive' }, { id: 'srv_2', display_name: 'Off', eligible: false }] })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    const message = JSON.parse(init.body ?? '{}') as { id?: number; method: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'proxy' } } })
    return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'list_recent_files', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } })
  }))
  stored.accounts = [{ id: 'auth:claude', kind: 'claude' }]
  accountConnectorTools('auth:claude')
  for (let i = 0; i < 50 && accountConnectorStatus('auth:claude')?.connecting !== false; i++) await new Promise((r) => setTimeout(r, 10))
  expect(accountConnectorStatus('auth:claude')).toMatchObject({ error: null, connectors: { 'Google Drive': 1 } })
  const tools = accountConnectorTools('auth:claude')
  expect(tools.map((tool) => [tool.name, tool.connector])).toEqual([['mcp__Google_Drive__list_recent_files', 'Google Drive']])
  const proxied = seen.filter((call) => call.url.startsWith(CLAUDE_PROXY_URL))
  expect(proxied.every((call) => call.url === `${CLAUDE_PROXY_URL}srv_1`)).toBe(true)
  expect(new Set(proxied.map((call) => call.headers['x-mcp-client-session-id'])).size).toBe(1)
  expect(proxied[0]!.headers['x-mcp-client-session-id']).toMatch(/^[0-9a-f-]{36}$/)
  expect(proxied[0]!.headers['anthropic-beta']).toContain('mcp-servers-2025-12-04')
  settings.claude = false
  expect(accountConnectorTools('auth:claude')).toEqual([])
  expect(() => tools[0]!.prepare({})).not.toThrow()
  await expect(tools[0]!.prepare({}).execute({ signal: new AbortController().signal } as never)).rejects.toThrow('not connected')
})

it('shares ChatGPT connectors with every model and tells duplicates apart', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string; method?: string }) => {
    const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.includes('/v1/mcp_servers')) return json({ data: [{ id: 'srv', display_name: 'Google Drive' }] })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    const message = JSON.parse(init.body ?? '{}') as { id?: number; method: string }
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: {} })
    return json({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'google_drive.list_recent_files', _meta: { connector_name: 'Google Drive' }, inputSchema: { type: 'object' } }] } })
  }))
  stored.accounts = [{ id: 'auth:codex', kind: 'codex' }, { id: 'auth:cline', kind: 'cline' }, { id: 'auth:codex-2', kind: 'codex' }]
  accountConnectorTools('auth:cline')
  for (let i = 0; i < 50 && [accountConnectorStatus('auth:codex'), accountConnectorStatus('auth:codex-2')].some((s) => s?.connecting !== false); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  // A Cline session gets both ChatGPT accounts' connectors, in stored order.
  expect(accountConnectorTools('auth:cline').map((tool) => [tool.name, tool.connector])).toEqual([
    ['mcp__Google_Drive__google_drive_list_recent_files', 'Google Drive'],
    ['mcp__codex-2_Google_Drive__google_drive_list_recent_files', 'Google Drive (codex-2)']
  ])
  expect(accountConnectorTools('openrouter').map((tool) => tool.name)).toEqual(accountConnectorTools('auth:claude-2').map((tool) => tool.name))
})
