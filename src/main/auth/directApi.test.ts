import { afterEach, expect, it, vi } from 'vitest'
import { directApiModels, loginDirectApi } from './directApi'
import { DIRECT_AUTH_PROVIDERS, isDirectAuthKind } from '@shared/directAuthProviders'
afterEach(() => vi.unstubAllGlobals())
it('validates each direct API key only against its configured upstream catalogue', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data: [{ id: 'account-model' }, { id: 'account-model' }, { id: 2 }] }))
  vi.stubGlobal('fetch', fetch)
  for (const kind of Object.keys(DIRECT_AUTH_PROVIDERS)) {
    if (!isDirectAuthKind(kind)) throw new Error('unexpected kind')
    const prompt = vi.fn(async () => 'fixture-key')
    const tokens = await loginDirectApi(kind, { signal: new AbortController().signal, onUpdate: vi.fn(), promptForCode: prompt })
    expect(tokens.meta?.directModels).toBe('["account-model"]')
    expect(fetch.mock.lastCall?.[0]).toBe(`${DIRECT_AUTH_PROVIDERS[kind].baseURL}/models`)
    expect(fetch.mock.lastCall?.[1]?.headers).toEqual({ Authorization: 'Bearer fixture-key' })
  }
})
it('rejects unavailable or empty catalogues instead of fabricating model aliases', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
  await expect(directApiModels('nvidia-nim', 'fixture')).rejects.toThrow('401')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })))
  await expect(directApiModels('nvidia-nim', 'fixture')).rejects.toThrow('valid live catalogue')
})
it('rejects cancellation and invalid keys before contacting upstream', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const signal = AbortSignal.abort()
  await expect(loginDirectApi('xai', { signal, onUpdate: vi.fn(), promptForCode: async () => 'fixture' })).rejects.toThrow()
  await expect(loginDirectApi('xai', { signal: new AbortController().signal, onUpdate: vi.fn(), promptForCode: async () => 'bad key' })).rejects.toThrow('without whitespace')
  expect(fetch).not.toHaveBeenCalled()
})
