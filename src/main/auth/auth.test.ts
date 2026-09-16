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

import { refreshCodex } from './codex'
import { loginCodebuddy } from './codebuddy'
import { saveAuthAccount, updateAuthTokens, getAuthAccount, resetAuthStoreForTests } from './store'
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
  await expect(refreshAuthAccount('auth:codebuddy')).rejects.toThrow(/sign in again/)
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
