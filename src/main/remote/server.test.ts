import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  /** The folder the fake session is bound to; set by the download tests. */
  root: null as string | null
}))
vi.mock('../settings', () => ({ loadPersistedSettings: () => mocks.settings, savePersistedSettings: (patch: object) => { Object.assign(mocks.settings, patch) } }))
vi.mock('../ipc', () => ({ approvals: { listPending: () => [], resolve: () => {} } }))
vi.mock('../runtime', () => ({
  getStatus: () => ({ provider: 'test', model: 'test', providerReady: true, workspaceRoot: mocks.root }),
  loadSessionMessages: (id: string) => id === 'test-session' ? [] : null,
  listSessionSummaries: () => [], listModels: async () => ({ models: [] }),
  sessionWorkspaceRoot: () => mocks.root
}))
vi.mock('../providers', () => ({ listProviders: () => [] }))
vi.mock('./bus', () => ({ subscribe: () => () => {}, registerRun: () => {}, forward: () => {}, forgetRun: () => {} }))
import { setRemoteEnabled, regenerateRemoteToken } from './server'
function origin(url: string): string { return url.replace(/http:\/\/[^:]+:/, 'http://127.0.0.1:').split('/?')[0]! }
afterEach(async () => {
  await setRemoteEnabled(false)
  if (mocks.root !== null) await rm(mocks.root, { recursive: true, force: true })
  mocks.root = null
})
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

it('stages an uploaded file and answers with a drawable reference', async () => {
  mocks.root = await mkdtemp(path.join(tmpdir(), 'anticode-remote-'))
  const status = await setRemoteEnabled(true, 0)
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#d1fa22' } })
    .png()
    .toBuffer()

  const response = await fetch(`${origin(status.url!)}/api/attachment?token=${status.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'layar.png', data: png.toString('base64') })
  })
  const body = (await response.json()) as { id: string; kind: string; thumbnail: string }
  expect(response.status).toBe(200)
  expect(body.kind).toBe('image')
  expect(body.thumbnail).toMatch(/^data:image\/jpeg;base64,/)
  expect(body.id).not.toBe('')
})

it('downloads a produced file and refuses one outside the folder', async () => {
  mocks.root = await mkdtemp(path.join(tmpdir(), 'anticode-remote-'))
  await writeFile(path.join(mocks.root, 'laporan.pdf'), 'bukan pdf sungguhan')
  const status = await setRemoteEnabled(true, 0)
  const base = origin(status.url!)

  const ok = await fetch(
    `${base}/api/download?sessionId=test-session&path=laporan.pdf&token=${status.token}`
  )
  expect(ok.status).toBe(200)
  expect(ok.headers.get('content-type')).toBe('application/pdf')
  expect(ok.headers.get('content-disposition')).toContain('laporan.pdf')
  expect(await ok.text()).toBe('bukan pdf sungguhan')

  const denied = await fetch(
    `${base}/api/download?sessionId=test-session&path=../luar.txt&token=${status.token}`
  )
  expect(denied.status).toBe(400)
})
