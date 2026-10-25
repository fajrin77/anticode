import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../auth/store', () => ({
  listAuthAccounts: () => [],
  getAuthAccount: (id: string) => (id === 'auth:cline' ? { id, kind: 'cline' } : undefined)
}))
vi.mock('../auth/provider', () => ({ ensureFreshAuthTokens: async () => ({ accessToken: 't' }) }))

const { accountConnectorTools, chatgptConnectorOf, connectorKind, connectorRisk, CHATGPT_APPS_URL, CLAUDE_PROXY_URL } = await import('./accountConnectors')

it('only ChatGPT and Claude accounts carry hosted connectors', () => {
  expect(connectorKind('codex')).toBe('codex')
  expect(connectorKind('claude')).toBe('claude')
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

it('offers nothing to providers without hosted connectors', () => {
  expect(accountConnectorTools(undefined)).toEqual([])
  expect(accountConnectorTools('openrouter')).toEqual([])
  expect(accountConnectorTools('auth:cline')).toEqual([])
  expect(CHATGPT_APPS_URL).toBe('https://chatgpt.com/backend-api/ps/mcp')
  expect(CLAUDE_PROXY_URL).toBe('https://mcp-proxy.anthropic.com/v1/mcp/')
})
