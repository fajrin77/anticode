import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('../settings', () => ({ loadPersistedSettings: () => mocks.settings, savePersistedSettings: (patch: object) => { Object.assign(mocks.settings, patch) } }))
vi.mock('../ipc', () => ({ approvals: { listPending: () => [], resolve: () => {} } }))
vi.mock('../runtime', () => ({
  getStatus: () => ({ provider: 'test', model: 'test', providerReady: true }),
  loadSessionMessages: (id: string) => id === 'test-session' ? [] : null,
  listSessionSummaries: () => [], listModels: async () => ({ models: [] }),
  sessionWorkspaceRoot: () => null
}))
vi.mock('../providers', () => ({ listProviders: () => [] }))
vi.mock('./bus', () => ({ subscribe: () => () => {}, registerRun: () => {}, forward: () => {}, forgetRun: () => {} }))
import { setRemoteEnabled, regenerateRemoteToken } from './server'
function origin(url: string): string { return url.replace(/http:\/\/[^:]+:/, 'http://127.0.0.1:').split('/?')[0]! }
afterEach(async () => { await setRemoteEnabled(false) })
it('enables idempotently and disables with an open SSE connection', async () => {
  const status = await setRemoteEnabled(true, 0)
  const again = await setRemoteEnabled(true, 0)
  expect(again.url).toBe(status.url)
  const response = await fetch(`${origin(status.url!)}/api/events?sessionId=test-session&token=${status.token}`)
  expect(response.status).toBe(200)
  await setRemoteEnabled(false)
  expect((await response.text())).toContain(': connected')
})
it('settles startup errors when a port is occupied, then allows retry', async () => {
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(0, '0.0.0.0', resolve))
  const port = (occupied.address() as { port: number }).port
  try { expect((await setRemoteEnabled(true, port)).error).toContain('EADDRINUSE') }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
  expect((await setRemoteEnabled(true, port)).error).toBeNull()
})
it('revokes an already-connected stream and denies the old token after rotation', async () => {
  const status = await setRemoteEnabled(true, 0)
  const base = origin(status.url!)
  const response = await fetch(`${base}/api/events?sessionId=test-session&token=${status.token}`)
  await regenerateRemoteToken()
  await response.text()
  expect((await fetch(`${base}/api/ping?token=${status.token}`)).status).toBe(401)
})
it('rejects malformed JSON and oversized bodies without hanging', async () => {
  const status = await setRemoteEnabled(true, 0)
  const url = `${origin(status.url!)}/api/model?token=${status.token}`
  expect((await fetch(url, {method:'POST',body:'null'})).status).toBe(400)
  expect((await fetch(url, {method:'POST',body:'{broken'})).status).toBe(400)
})
