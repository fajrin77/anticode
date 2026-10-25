import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { opened, callback, command } = vi.hoisted(() => ({ opened: vi.fn(async (_url: string) => {}), callback: vi.fn(), command: vi.fn(async () => ({ executable: 'fixture', prefix: [] })) }))
vi.mock('electron', () => ({ shell: { openExternal: opened } }))
vi.mock('./server', () => ({ waitForCallback: callback }))
vi.mock('../providers/cursorCli', () => ({ cursorCommand: command }))
import { loginAntigravity } from './antigravity'
import { loginCursor } from './cursor'
const callbacks = () => ({ signal: new AbortController().signal, onUpdate: vi.fn(), promptForCode: async () => '' })
beforeEach(() => { vi.stubEnv('ANTICODE_ANTIGRAVITY_CLIENT_ID', 'fixture-client'); vi.stubEnv('ANTICODE_ANTIGRAVITY_CLIENT_SECRET', 'fixture-secret') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks() })

it('Cursor authorizes PKCE in browser, stores identity and does not request pasted tokens', async () => {
  const jwt = `fixture.${Buffer.from(JSON.stringify({ email: 'fixture@example.test', exp: 4000000000 })).toString('base64url')}.signature`
  const fetch = vi.fn(async (_url: URL) => Response.json({ accessToken: jwt, refreshToken: 'fixture-refresh' }))
  vi.stubGlobal('fetch', fetch)
  const result = await loginCursor(callbacks())
  expect(result.meta?.account).toBe('fixture@example.test')
  const url = new URL(opened.mock.calls[0]![0] as string)
  const poll = new URL(fetch.mock.calls[0]![0] as unknown as string)
  expect(url.pathname).toBe('/loginDeepControl')
  expect(url.searchParams.get('uuid')).toBe(poll.searchParams.get('uuid'))
  expect(url.searchParams.get('challenge')).toHaveLength(43)
  expect(poll.searchParams.get('verifier')).toBeTruthy()
})
it('Cursor organization denial fails without an API-key fallback', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  await expect(loginCursor(callbacks())).rejects.toThrow('denied')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('Antigravity browser callback checks state before exchanging a token', async () => {
  callback.mockImplementationOnce(async (options: { onListening: () => void }) => { options.onListening(); return { state: 'wrong', code: 'fixture' } })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(loginAntigravity(callbacks())).rejects.toThrow('state mismatch')
  expect(fetch).not.toHaveBeenCalled()
})
it('Antigravity PKCE login resolves a managed project and identity', async () => {
  callback.mockImplementationOnce(async (options: { onListening: () => void }) => {
    options.onListening()
    const url = new URL(opened.mock.calls[0]![0] as string)
    return { state: url.searchParams.get('state'), code: 'fixture' }
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'fixture', refresh_token: 'refresh', expires_in: 3600 })
    if (url.includes('loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'managed-fixture' } })
    return Response.json({ email: 'fixture@example.test' })
  }))
  const result = await loginAntigravity(callbacks())
  expect(result.meta).toEqual({ account: 'fixture@example.test', project: 'managed-fixture' })
  expect(new URL(opened.mock.calls[0]![0] as string).searchParams.get('code_challenge_method')).toBe('S256')
})
