import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
import { copilotModels, loginCopilot } from './copilot'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
it('only exposes enabled models that explicitly support chat completions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
    { id: 'enabled', supported_endpoints: ['/chat/completions'] },
    { id: 'disabled', policy: { state: 'disabled' }, supported_endpoints: ['/chat/completions'] },
    { id: 'responses-only', supported_endpoints: ['/responses'] },
    { id: 'unknown' }
  ] })))
  expect(await copilotModels('fixture')).toEqual(['enabled'])
})
it('fails closed on subscription errors without a fallback route', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  await expect(copilotModels('fixture')).rejects.toThrow('403')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('cancels device authorization without storing or polling tokens', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ device_code: 'fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device' })))
  const controller = new AbortController()
  const updates: string[] = []
  const login = loginCopilot({ signal: controller.signal, promptForCode: async () => '', onUpdate: (u) => { updates.push(u.message); controller.abort() } })
  await expect(login).rejects.toThrow()
  expect(updates[0]).toContain('ABCD-EFGH')
})
