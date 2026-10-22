import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-auth-'))
let encryptionAvailable = true
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: () => Promise.resolve() },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => {
      const raw = value.toString()
      if (!raw.startsWith('encrypted:')) throw new Error('not ours')
      return raw.slice('encrypted:'.length)
    }
  }
}))

import { authModelsFor, fetchFreeGatewayModels, fetchClineModels, fetchCodexModels, parseClineFreeModels, markClineRestricted } from './catalogue'
import { savePersistedSettings } from '../settings'
import { CODEX_CLIENT_VERSION } from '../providers/codexConfig'
import { ensureFreshAuthTokens } from './provider'
import { refreshCodex } from './codex'
import { coolDown, coolingUntil } from '../rotation'
import { loginCodebuddy } from './codebuddy'
import { saveAuthAccount, readAuthTokens, updateAuthTokens, getAuthAccount, resetAuthStoreForTests } from './store'
import { authProviderId, listAuthAccountSummaries, refreshAuthAccount, removeAuthAccount } from './index'
import type { AuthAccount } from './types'

function idToken(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${body}.signature`
}

function account(id: string, kind: AuthAccount['kind']): AuthAccount {
  return { id, kind, label: id, createdAt: Date.now(), refreshable: true }
}

afterEach(() => {
  encryptionAvailable = true
  vi.unstubAllGlobals()
})

it('keeps the ChatGPT account id, not the email, for the Codex backend header', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh',
          expires_in: 3600,
          id_token: idToken({
            email: 'someone@example.com',
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'pro' }
          })
        }),
        { status: 200 }
      )
  )
  const next = await refreshCodex({ accessToken: 'old', refreshToken: 'r1' })
  expect(next.meta?.accountId).toBe('acct_123')
  expect(next.meta?.email).toBe('someone@example.com')
  // The grant returned no new refresh token, so the old one has to survive.
  expect(next.refreshToken).toBe('r1')
  expect(next.expiresAt).toBeGreaterThan(Date.now())
})

it('says what the vendor said when a grant is refused', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Refresh token expired' }), {
        status: 400
      })
  )
  await expect(refreshCodex({ accessToken: 'old', refreshToken: 'r1' })).rejects.toThrow(
    /Refresh token expired/
  )
})

it('names re-login as the way out when the stored ChatGPT login is dead', async () => {
  vi.stubGlobal('fetch', async () => new Response('Unauthorized', { status: 401 }))
  await expect(refreshCodex({ accessToken: 'old', refreshToken: 'dead' })).rejects.toThrow(/Sign in again/)
})

it('numbers a second account of the same vendor so both can be rotated between', () => {
  resetAuthStoreForTests()
  expect(authProviderId('codex', '')).toBe('auth:codex')
  saveAuthAccount(account('auth:codex', 'codex'), { accessToken: 'a', refreshToken: 'r' })
  saveAuthAccount(account('auth:codex-2', 'codex'), { accessToken: 'b', refreshToken: 'r' })
  expect(listAuthAccountSummaries().map((row) => row.id)).toEqual(['auth:codex', 'auth:codex-2'])
  removeAuthAccount('auth:codex-2')
})

it('keeps the expiry and the renewable flag in step with the tokens on file', () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:claude', 'claude'), {
    accessToken: 'a',
    refreshToken: 'r',
    expiresAt: Date.now() + 3600_000
  })
  // A vendor that stops saying when the token dies must not leave 1970 behind,
  // and a refresh token that goes away must stop the UI offering Renew.
  updateAuthTokens('auth:claude', { accessToken: 'b', expiresAt: 0 })
  const stored = getAuthAccount('auth:claude')
  expect(stored?.expiresAt).toBeUndefined()
  expect(stored?.refreshable).toBe(false)
  removeAuthAccount('auth:claude')
})

it('lists an account whose seal will not open as unusable rather than hiding it', () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:cline', 'cline'), { accessToken: 'a', refreshToken: 'r' })
  expect(listAuthAccountSummaries()[0]?.usable).toBe(true)
  encryptionAvailable = false
  expect(listAuthAccountSummaries()[0]?.usable).toBe(false)
  encryptionAvailable = true
  removeAuthAccount('auth:cline')
})

it('turns a renewal the vendor cannot do into advice instead of a bare failure', async () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:codebuddy', 'codebuddy'), { accessToken: 'a' })
  await expect(refreshAuthAccount('auth:codebuddy')).rejects.toThrow(/Sign in again/)
  await expect(refreshAuthAccount('auth:nothing')).rejects.toThrow(/no longer stored/)

  saveAuthAccount(account('auth:claude', 'claude'), { accessToken: 'a' })
  await expect(refreshAuthAccount('auth:claude')).rejects.toThrow(/without a refresh token/)
  removeAuthAccount('auth:codebuddy')
  removeAuthAccount('auth:claude')
})

it('stops a CodeBuddy login the moment it is cancelled instead of polling on', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    calls += 1
    if (init?.signal?.aborted === true) throw new Error('The operation was aborted')
    return new Response(JSON.stringify({ data: { state: 's', authUrl: 'https://x.test' } }), { status: 200 })
  })
  await expect(
    loginCodebuddy({ onUpdate: () => {}, promptForCode: async () => '', signal: controller.signal })
  ).rejects.toThrow()
  // The very first request already carries the signal; nothing gets to poll.
  expect(calls).toBe(1)
})


it('shares one refresh grant across concurrent chats and the manual Renew action', async () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:codex', 'codex'), { accessToken: 'old', refreshToken: 'r1', expiresAt: 1 })
  let complete!: (response: Response) => void
  let calls = 0
  vi.stubGlobal('fetch', () => {
    calls++
    return new Promise<Response>((resolve) => { complete = resolve })
  })
  const first = ensureFreshAuthTokens('auth:codex')
  const second = ensureFreshAuthTokens('auth:codex')
  const manual = refreshAuthAccount('auth:codex')
  expect(calls).toBe(1)
  complete(new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })))
  expect((await first).accessToken).toBe('fresh')
  expect((await second).refreshToken).toBe('rotated')
  await manual
  expect(readAuthTokens('auth:codex')?.refreshToken).toBe('rotated')
  expect(calls).toBe(1)
  removeAuthAccount('auth:codex')
})


it('marks a login the vendor refuses to renew so routing moves to another account', async () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:cline', 'cline'), { accessToken: 'old', refreshToken: 'dead', expiresAt: 1 })
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, error: 'failed to refresh token: invalid_grant' }), { status: 400 }))
  const error = (await ensureFreshAuthTokens('auth:cline', true).then(() => null, (caught: unknown) => caught)) as { message: string; status?: number; scope?: string; retryAt?: number }
  expect(error.message).toMatch(/Sign in again/)
  expect(error).toMatchObject({ status: 401, scope: 'account' })
  expect(error.retryAt).toBeGreaterThan(Date.now())
  removeAuthAccount('auth:cline')
})

it.each(['codex', 'claude', 'cline', 'codebuddy'] as const)('automatically renews %s before expiry and preserves the rotated refresh token', async (kind) => {
  const id = `auth:${kind}-auto-refresh`
  saveAuthAccount(account(id, kind), { accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 1000 })
  let calls = 0
  vi.stubGlobal('fetch', async () => {
    calls++
    const tokens = { accessToken: 'fresh', refreshToken: 'r2', expiresIn: 3600, expiresAt: Date.now() + 3600000 }
    return new Response(JSON.stringify(kind === 'cline' ? { success: true, data: tokens } : kind === 'codebuddy' ? { data: tokens } : { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }))
  })
  expect((await ensureFreshAuthTokens(id)).accessToken).toBe('fresh')
  expect((await ensureFreshAuthTokens(id)).refreshToken).toBe('r2')
  expect(calls).toBe(1)
  removeAuthAccount(id)
})

it.each(['codex', 'claude', 'cline', 'codebuddy'] as const)('does not mark %s login dead when renewal encounters a temporary outage', async (kind) => {
  const id = `auth:${kind}-refresh-outage`
  saveAuthAccount(account(id, kind), { accessToken: 'old', refreshToken: 'r1', expiresAt: 1 })
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }))
  await expect(ensureFreshAuthTokens(id, true)).rejects.toMatchObject({ status: 503 })
  expect(readAuthTokens(id)?.refreshToken).toBe('r1')
  removeAuthAccount(id)
})

it('clears only an old login cooldown after successful renewal, preserving quota cooldowns', async () => {
  const id = 'auth:codex-renew-cooldown'
  saveAuthAccount(account(id, 'codex'), { accessToken: 'old', refreshToken: 'r1' })
  const entry = { provider: id, model: 'gpt-6.1-sol' }
  coolDown(entry, Date.now(), { status: 401, retryAt: Date.now() + 3600000 })
  expect(coolingUntil(entry)).not.toBeNull()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 })))
  await ensureFreshAuthTokens(id, true)
  expect(coolingUntil(entry)).toBeNull()
  coolDown(entry, Date.now(), { scope: 'account', retryAt: Date.now() + 3600000 })
  await ensureFreshAuthTokens(id, true)
  expect(coolingUntil(entry)).not.toBeNull()
  removeAuthAccount(id)
})


it('refreshes the modern account catalogue while retaining bundled choices from a short snapshot', async () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:codex', 'codex'), { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 })
  let requested = ''
  vi.stubGlobal('fetch', async (url: string) => {
    requested = String(url)
    return new Response(JSON.stringify({ models: [{ slug: 'gpt-6-astra' }, { slug: 'new-account-model' }] }))
  })
  const models = await fetchCodexModels('auth:codex')
  expect(new URL(requested).searchParams.get('client_version')).toBe(CODEX_CLIENT_VERSION)
  expect(models).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'new-account-model']))
  removeAuthAccount('auth:codex')
})


it('combines only free public aliases and the free promotion feed', () => {
  expect(parseClineFreeModels({ data: [
    { id: 'anthropic/claude-sonnet-5.5' }, { id: 'meta/muse-spark-1.3-contributor' },
    { id: 'google/gemma-4-31b-it:free' }, { id: 'openrouter/free' }
  ] }, { free: [{ id: 'cline-free/muse-spark-1.3-contributor' }, { id: 'cline-pass/paid' }, null],
    recommended: [{ id: 'paid/recommended' }], clinePass: [{ id: 'cline-pass/other' }] }))
    .toEqual(['cline-free/muse-spark-1.3-contributor', 'google/gemma-4-31b-it:free', 'openrouter/free'])
})

it('removes paid models from an older Cline cache and retains free models offline', async () => {
  resetAuthStoreForTests()
  saveAuthAccount(account('auth:cline', 'cline'), { accessToken: 'at', expiresAt: Date.now() + 3600_000 })
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify(String(url).endsWith('/models')
      ? { data: [{ id: 'google/gemma-4-31b-it:free' }, { id: 'paid/model' }] }
      : { free: [{ id: 'reflection/beam-free' }], recommended: [{ id: 'paid/featured' }] }))
  })
  const models = await fetchClineModels('auth:cline')
  expect(urls).toContain('https://api.cline.bot/api/v1/ai/cline/recommended-models')
  expect(models).toContain('google/gemma-4-31b-it:free')
  expect(models).toContain('reflection/beam-free')
  expect(models).not.toContain('paid/model')
  expect(models).not.toContain('paid/featured')
  markClineRestricted('auth:cline', 'cline-free/muse-spark-1.3-contributor', 'Official apps only')
  const refreshed = await fetchClineModels('auth:cline')
  expect(refreshed).not.toContain('cline-free/muse-spark-1.3-contributor')
  vi.stubGlobal('fetch', async () => { throw new Error('offline') })
  expect(await fetchClineModels('auth:cline')).toEqual(refreshed)
  expect(authModelsFor('auth:cline', 'cline')).toEqual(refreshed)
  removeAuthAccount('auth:cline')
})

it('deduplicates official-app promotions only when their public free routes are available', () => {
  savePersistedSettings({ authModelCatalogues: { 'auth:cline-routes': {
    models: ['cline-free/minimax-m3.1-flash', 'minimax/minimax-m3.1-flash:free', 'cline-free/nemotron-3.5-super-vl', 'nvidia/nemotron-3.5-super-vl:free', 'cline-free/muse-spark-1.3-contributor'],
    checkedAt: Date.now(), freeOnly: true
  } } })
  expect(authModelsFor('auth:cline-routes', 'cline')).toEqual(['minimax/minimax-m3.1-flash:free', 'nvidia/nemotron-3.5-super-vl:free', 'cline-free/muse-spark-1.3-contributor'])
})


it.each(['kilo', 'openrouter'] as const)('filters paid aliases and keeps the last free %s catalogue when offline', async kind => {
  const id = `auth:free-catalogue-${kind}`
  saveAuthAccount(account(id, kind), { accessToken: 'fixture-key', expiresAt: 0 })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'paid/model' }, { id: 'free/model:free' }] })))
  expect(await fetchFreeGatewayModels(id, kind)).toEqual(['free/model:free'])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid JSON')))
  expect(await fetchFreeGatewayModels(id, kind)).toEqual(['free/model:free'])
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [] })))
  expect(await fetchFreeGatewayModels(id, kind)).toEqual([])
})

it.each(['kilo', 'openrouter'] as const)('rejects a paid model before a %s browser connection sends credentials', async kind => {
  const { authProvider } = await import('./provider')
  const id = `auth:guard-${kind}`
  saveAuthAccount(account(id, kind), { accessToken: 'fixture-key', expiresAt: 0 })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await expect((async () => {
    for await (const _ of authProvider(id, 'paid/model').chat({ system: '', messages: [], tools: [], maxTokens: 100, signal: new AbortController().signal })) { /* consume */ }
  })()).rejects.toThrow(/free model routes only/)
  expect(fetcher).not.toHaveBeenCalled()
})
