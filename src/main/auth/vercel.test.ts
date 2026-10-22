import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-vercel-'))
const openedUrls: string[] = []
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: (url: string) => { openedUrls.push(url); return Promise.resolve() } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  }
}))

import { loginVercel, VERCEL_GATEWAY_BASE } from './vercel'
import { authProvider } from './provider'
import { saveAuthAccount, resetAuthStoreForTests } from './store'
import type { AuthLoginCallbacks } from './types'

const realFetch = globalThis.fetch.bind(globalThis)

function callbacks(pasted: string): AuthLoginCallbacks {
  return {
    onUpdate: () => {},
    promptForCode: async () => pasted,
    signal: new AbortController().signal
  }
}

function stubFetch(status: number): string[] {
  const seen: string[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    // Localhost is only used by OAuth callbacks, which this flow never opens.
    if (!String(url).startsWith('https://ai-gateway.vercel.sh')) return realFetch(url, init)
    seen.push(`${init?.method ?? 'GET'} ${url}`)
    return Promise.resolve(new Response('{"data":[]}', { status }))
  })
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetAuthStoreForTests()
})

it('opens the key page, checks the key, and stores it without a refresh token', async () => {
  openedUrls.length = 0
  const seen = stubFetch(200)
  const tokens = await loginVercel(callbacks('  vck_live_key_1234567890  '))
  expect(openedUrls[0]).toContain('vercel.com')
  expect(seen[0]).toBe(`GET ${VERCEL_GATEWAY_BASE}/models`)
  expect(tokens.accessToken).toBe('vck_live_key_1234567890')
  // 0 means "cannot renew": the panel tells the user to sign in again instead.
  expect(tokens.expiresAt).toBe(0)
  expect(tokens.refreshToken).toBeUndefined()
})

it('refuses an empty key and a key the gateway rejects', async () => {
  await expect(loginVercel(callbacks('   '))).rejects.toThrow(/key is required/)
  stubFetch(401)
  await expect(loginVercel(callbacks('vck_live_key_1234567890'))).rejects.toThrow(/rejected this key/)
})

it('routes to the gateway with the stored key and only free models', async () => {
  stubFetch(200)
  const tokens = await loginVercel(callbacks('vck_live_key_1234567890'))
  const account = { id: 'auth:vercel', kind: 'vercel' as const, label: 'Vercel', createdAt: Date.now(), refreshable: false }
  saveAuthAccount(account, tokens)
  const provider = authProvider(account.id, 'openai/gpt-oss-20b:free')
  expect(provider.name).toBe('vercel')
  const paid = authProvider(account.id, 'openai/gpt-4.1')
  await expect(async () => {
    for await (const _ of paid.chat({ messages: [], signal: new AbortController().signal } as never)) void _
  }).rejects.toThrow(/free model routes only/)
})
