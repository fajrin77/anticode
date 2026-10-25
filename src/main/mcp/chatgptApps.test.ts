import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0', getPath: () => '/tmp' }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../auth/store', () => ({ listAuthAccounts: () => [] }))
vi.mock('../auth/provider', () => ({ ensureFreshAuthTokens: async () => ({ accessToken: 't' }) }))

const { connectorAccount, driveRisk, driveTools, chatgptAppsTools, CHATGPT_APPS_URL } = await import('./chatgptApps')
const { mcpToolName } = await import('./manager')

it('offers only the Google Drive connector tools of the ChatGPT catalogue', () => {
  const tools = [
    { name: 'google_drive.batch_update_spreadsheet', description: '', inputSchema: {} },
    { name: 'google_calendar.create_event', description: '', inputSchema: {} },
    { name: 'gmail.send_email', description: '', inputSchema: {} }
  ]
  expect(driveTools(tools).map((tool) => tool.name)).toEqual(['google_drive.batch_update_spreadsheet'])
})

it('lets reads run, asks for writes, and always asks for destructive calls', () => {
  expect(driveRisk({ annotations: { readOnlyHint: true } })).toBe('low')
  expect(driveRisk({ annotations: { readOnlyHint: false } })).toBe('medium')
  expect(driveRisk({})).toBe('medium')
  expect(driveRisk({ annotations: { readOnlyHint: true, destructiveHint: true } })).toBe('high')
})

it('runs under a stored ChatGPT account only, and offers nothing without one', () => {
  expect(connectorAccount([{ id: 'auth:claude', kind: 'claude' }, { id: 'auth:codex', kind: 'codex' }])).toBe('auth:codex')
  expect(connectorAccount([{ id: 'auth:claude', kind: 'claude' }])).toBeNull()
  expect(chatgptAppsTools()).toEqual([])
})

it('names Drive tools so the activity line reads "Used Google Drive integration"', () => {
  expect(CHATGPT_APPS_URL).toBe('https://chatgpt.com/backend-api/ps/mcp')
  const name = mcpToolName('Google Drive', 'google_drive.batch_update_spreadsheet')
  expect(name).toBe('mcp__Google_Drive__google_drive_batch_update_spreadsheet')
  expect(name.length).toBeLessThanOrEqual(64)
})
