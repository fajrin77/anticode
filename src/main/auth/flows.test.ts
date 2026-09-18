import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-auth-flows-'))
const openedUrls: string[] = []
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: (url: string) => { openedUrls.push(url); return Promise.resolve() } },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => {
      const raw = value.toString()
      if (!raw.startsWith('encrypted:')) throw new Error('not ours')
      return raw.slice('encrypted:'.length)
    }
  }
}))

import { loginCodex } from './codex'
import { loginClaude, refreshClaude } from './claude'
import { loginCline, refreshCline } from './cline'
import { waitForCallback } from './server'
import {
  saveAuthAccount, readAuthTokens, resetAuthStoreForTests
} from './store'
import { authProvider } from './provider'
import type { AuthLoginCallbacks } from './types'

function idToken(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `header.${body}.signature`
}

function callbacks(overrides: Partial<AuthLoginCallbacks> = {}): AuthLoginCallbacks {
  return {
    onUpdate: () => {},
    promptForCode: async () => { throw new Error('no code') },
    signal: new AbortController().signal,
    ...overrides
  }
}

/** The stubbed global fetch must let localhost OAuth callbacks through. */
const realFetch = globalThis.fetch.bind(globalThis)
function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    String(url).startsWith('http://127.0.0.1:') ? realFetch(url, init) : handler(url, init)
  )
}

function authOf(init?: RequestInit): string {
  const headers = init?.headers
  if (headers instanceof Headers) return headers.get('authorization') ?? ''
  return (headers as Record<string, string> | undefined)?.['authorization'] ?? ''
}

afterEach(() => {
  openedUrls.length = 0
  vi.unstubAllGlobals()
  resetAuthStoreForTests()
})

it('waits for the localhost callback and reports its code and state', async () => {
  const waited = waitForCallback({ ports: [14711], path: '/auth/callback' })
  const params = new URLSearchParams({ code: 'abc', state: 's1' })
  const response = await fetch(`http://127.0.0.1:14711/auth/callback?${params}`)
  expect(response.status).toBe(200)
  await expect(waited).resolves.toEqual({ code: 'abc', state: 's1' })
})

it('aborts the callback wait when the login is cancelled', async () => {
  const controller = new AbortController()
  const waited = waitForCallback({ ports: [14712], path: '/auth/callback', signal: controller.signal })
  controller.abort()
  await expect(waited).rejects.toThrow(/cancelled/i)
})

it('runs the Codex PKCE login end to end against mocks', async () => {
  let seenUrl = ''
  stubFetch(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'at-new',
          expires_in: 3600,
          id_token: idToken({
            email: 'plus@example.com',
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct_9', chatgpt_plan_type: 'plus' }
          })
        }),
        { status: 200 }
      )
  )
  const done = loginCodex(
    callbacks({
      onUpdate: (u) => {
        if (u.url !== undefined) {
          seenUrl = u.url
          const parsed = new URL(u.url)
          const state = parsed.searchParams.get('state') ?? ''
          const redirect = new URL(parsed.searchParams.get('redirect_uri') ?? '')
          void fetch(
            `http://127.0.0.1:${redirect.port}/auth/callback?${new URLSearchParams({ code: 'code-1', state })}`
          )
        }
      }
    })
  )
  const tokens = await done
  expect(tokens.accessToken).toBe('at-new')
  expect(tokens.meta?.accountId).toBe('acct_9')
  expect(tokens.meta?.plan).toBe('plus')
  const url = new URL(seenUrl)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('redirect_uri')).toContain('localhost:1455')
})

it('refuses a Codex callback whose state does not match', async () => {
  stubFetch(async () => new Response('{}', { status: 200 }))
  await expect(
    loginCodex(
      callbacks({
        onUpdate: (u) => {
          if (u.url !== undefined) {
            const redirect = new URL(new URL(u.url).searchParams.get('redirect_uri') ?? '')
            void fetch(`http://127.0.0.1:${redirect.port}/auth/callback?code=x&state=tampered`)
          }
        }
      })
    )
  ).rejects.toThrow(/state/i)
})

it('runs the Claude paste-code login, bare code or callback URL', async () => {
  stubFetch(
    async () =>
      new Response(
        JSON.stringify({
          access_token: 'claude-at',
          refresh_token: 'claude-rt',
          expires_in: 3600,
          account: { email_address: 'pro@example.com' }
        }),
        { status: 200 }
      )
  )
  const bare = await loginClaude(callbacks({ promptForCode: async () => 'PASTE-ME' }))
  expect(bare.accessToken).toBe('claude-at')
  expect(bare.meta?.email).toBe('pro@example.com')
  const viaUrl = await loginClaude(
    callbacks({ promptForCode: async () => 'https://console.anthropic.com/oauth/code/callback?code=ABC&state=ST#x' })
  )
  expect(viaUrl.accessToken).toBe('claude-at')
})

it('keeps the old Claude refresh token when the grant omits a new one', async () => {  stubFetch(
    async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 60 }), { status: 200 })
  )
  const next = await refreshClaude({ accessToken: 'old', refreshToken: 'keep-me' })
  expect(next.accessToken).toBe('fresh')
  expect(next.refreshToken).toBe('keep-me')
})

it('runs the Cline WorkOS login end to end against mocks', async () => {
  stubFetch(async (url: string) => {
    if (url.includes('api.workos.com')) {
      return new Response(JSON.stringify({ access_token: 'workos-at', refresh_token: 'workos-rt' }), { status: 200 })
    }
    if (url.includes('api.cline.bot/api/v1/auth/token')) {
      return new Response(JSON.stringify({ accessToken: 'cline-session', refreshToken: 'cline-rt' }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  const tokens = await loginCline(
    callbacks({
      onUpdate: (u) => {
        if (u.url !== undefined) {
          const parsed = new URL(u.url)
          const state = parsed.searchParams.get('state') ?? ''
          const callback = new URL(parsed.searchParams.get('callback_url') ?? '')
          void realFetch(`http://127.0.0.1:${callback.port}/auth?${new URLSearchParams({ code: 'cline-code', state })}`)
        }
      }
    })
  )
  expect(tokens.accessToken).toBe('cline-session')
  expect(tokens.refreshToken).toBe('cline-rt')
})

it('renews a Cline session token and keeps the old one as fallback', async () => {
  stubFetch(async () => new Response(JSON.stringify({ accessToken: 'cline-fresh' }), { status: 200 }))
  const next = await refreshCline({ accessToken: 'old', refreshToken: 'rt' })
  expect(next.accessToken).toBe('cline-fresh')
  expect(next.refreshToken).toBe('rt')
})

it('renews an expired Claude token mid-turn and retries once', async () => {  saveAuthAccount(
    { id: 'auth:claude', kind: 'claude', label: 'Claude', createdAt: Date.now(), refreshable: true },
    { accessToken: 'stale', refreshToken: 'rt', expiresAt: Date.now() - 1000 }
  )
  const sseOk = (text: string): string =>
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n` +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  let messagesCalls = 0
  stubFetch(async (url: string, init?: RequestInit) => {
    if (url.includes('/v1/models/')) {
      return new Response(JSON.stringify({ max_tokens: 4096 }), { status: 200 })
    }
    if (url.includes('console.anthropic.com/v1/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'rt2', expires_in: 3600 }), { status: 200 })
    }
    if (url.includes('/v1/messages')) {
      messagesCalls += 1
      const auth = authOf(init)
      if (messagesCalls === 1) {
        expect(auth).toBe('Bearer stale')
        return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid_token' } }), { status: 401 })
      }
      expect(auth).toBe('Bearer fresh')
      return new Response(sseOk('hasil akun Plus'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  const provider = authProvider('auth:claude', 'claude-sonnet-4-5')
  const texts: string[] = []
  for await (const event of provider.chat({
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
    tools: [],
    maxTokens: 100,
    signal: new AbortController().signal
  })) {
    if (event.type === 'text_delta') texts.push(event.text)
  }
  expect(texts.join('')).toContain('hasil akun Plus')
  expect(messagesCalls).toBe(2)
  expect(readAuthTokens('auth:claude')?.accessToken).toBe('fresh')
})
