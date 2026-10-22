import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-auth-flows-'))
const openedUrls: string[] = []
// This tests the auth wrapper's refresh contract. The real Claude Code bridge
// has its own protocol fixtures; never spawn a real CLI with fixture tokens.
vi.mock('../providers/claudeCode', async () => {
  const { AnthropicProvider } = await import('../providers/anthropic')
  return { ClaudeCodeProvider: class extends AnthropicProvider {
    constructor(_id: string, model: string, token: string) { super('', model, undefined, { authToken: token }) }
  } }
})
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
import { loginCodebuddy, refreshCodebuddy } from './codebuddy'
import { loginOpenCodeGo } from './opencodeGo'
import { loginCline, refreshCline } from './cline'
import { waitForCallback } from './server'
import {
  saveAuthAccount, readAuthTokens, resetAuthStoreForTests
} from './store'
import { authProvider } from './provider'
import { savePersistedSettings } from '../settings'
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

it('runs Claude login with a bare code, code#state, or callback URL with a fragment', async () => {
  let state = ''
  const exchanged: Record<string, string>[] = []
  stubFetch(
    async (url, init) => {
      expect(url).toBe('https://api.anthropic.com/v1/oauth/token')
      exchanged.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          access_token: 'claude-at',
          refresh_token: 'claude-rt',
          expires_in: 3600,
          account: { uuid: 'user-1', email_address: 'pro@example.com' },
          organization: { uuid: 'org-1' }
        }),
        { status: 200 }
      )
    }
  )
  const bare = await loginClaude(callbacks({ promptForCode: async () => 'PASTE-ME' }))
  expect(bare.accessToken).toBe('claude-at')
  expect(bare.meta?.email).toBe('pro@example.com')
  for (const format of ['short', 'url']) {
    const tokens = await loginClaude(callbacks({
      onUpdate: update => { if (update.url) state = new URL(update.url).searchParams.get('state') ?? '' },
      promptForCode: async () => format === 'short' ? `ABC#${state}` : `https://console.anthropic.com/oauth/code/callback?code=ABC&state=${state}#x`
    }))
    expect(tokens.meta?.accountId).toBe('user-1/org-1')
    expect(exchanged.at(-1)).toMatchObject({ code: 'ABC', state })
    expect(exchanged.at(-1)?.code_verifier).toBeTruthy()
  }
})

it('rejects a Claude code from another flow before exchanging it', async () => {
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  await expect(loginClaude(callbacks({ promptForCode: async () => 'ABC#foreign-state' }))).rejects.toThrow(/another Sign in attempt/)
  expect(request).not.toHaveBeenCalled()
})

it('rejects a Claude token response without credentials', async () => {
  stubFetch(async () => Response.json({ expires_in: 60 }))
  await expect(loginClaude(callbacks({ promptForCode: async () => 'ABC' }))).rejects.toThrow(/no access token/)
})

it('keeps the old Claude refresh token when the grant omits a new one', async () => {  stubFetch(
    async () => new Response(JSON.stringify({ access_token: 'fresh', expires_in: 60 }), { status: 200 })
  )
  const next = await refreshClaude({ accessToken: 'old', refreshToken: 'keep-me', meta: { accountId: 'user/org', userId: 'user', organizationId: 'org', email: 'a@example.com' } })
  expect(next.accessToken).toBe('fresh')
  expect(next.refreshToken).toBe('keep-me')
  expect(next.meta).toMatchObject({ accountId: 'user/org', email: 'a@example.com' })
})

it('tells the user to sign in again when a refresh grant is refused', async () => {
  stubFetch(async () => new Response('Unauthorized', { status: 401 }))
  await expect(refreshClaude({ accessToken: 'old', refreshToken: 'dead' })).rejects.toThrow(/Sign in again/)
  await expect(refreshCline({ accessToken: 'old', refreshToken: 'dead' })).rejects.toThrow(/Sign in again/)
})

it('runs the Cline WorkOS login end to end against mocks', async () => {
  let authorizeHost = ''
  stubFetch(async (url: string) => {
    if (url.includes('/api/v1/auth/token')) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            accessToken: 'cline-session',
            refreshToken: 'cline-rt',
            tokenType: 'Bearer',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            userInfo: { email: 'cline@example.com' }
          }
        }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  const tokens = await loginCline(
    callbacks({
      onUpdate: (u) => {
        if (u.url !== undefined) {
          const parsed = new URL(u.url)
          authorizeHost = parsed.host
          const state = parsed.searchParams.get('state') ?? ''
          const callback = new URL(parsed.searchParams.get('callback_url') ?? '')
          void realFetch(`${callback.origin}${callback.pathname}?${new URLSearchParams({ code: 'cline-code', state })}`)
        }
      }
    })
  )
  // The authorize page lives on the API host; app.cline.bot 404s.
  expect(authorizeHost).toBe('api.cline.bot')
  expect(tokens.accessToken).toBe('cline-session')
  expect(tokens.refreshToken).toBe('cline-rt')
  expect(tokens.expiresAt).toBeGreaterThan(Date.now())
})

it('renews a Cline session token and keeps the old one as fallback', async () => {
  stubFetch(async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: { accessToken: 'cline-fresh', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 3600_000).toISOString(), userInfo: { email: '' } }
      }),
      { status: 200 }
    )
  )
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
    if (url.endsWith('/api/oauth/profile')) return Response.json({ account: { has_claude_pro: true }, organization: { subscription_status: 'active' } })
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } })
    if (url.includes('/v1/models/')) {
      return new Response(JSON.stringify({ max_tokens: 4096 }), { status: 200 })
    }
    if (url.includes('api.anthropic.com/v1/oauth/token')) {
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

it('accepts Cline callbacks without state only at the unpredictable callback path', async () => {
  let exchangeCalls = 0
  stubFetch(async () => {
    exchangeCalls++
    return new Response(JSON.stringify({ success: true, data: { accessToken: 'session', refreshToken: 'refresh' } }))
  })
  let badPathStatus = 0
  const tokens = await loginCline(callbacks({ onUpdate: (update) => {
    if (!update.url) return
    const url = new URL(update.url)
    const callback = new URL(url.searchParams.get('callback_url')!)
    expect(callback.pathname).toMatch(/^\/auth\/[a-f0-9]{32}$/)
    void (async () => {
      badPathStatus = (await realFetch(`${callback.origin}/auth?code=unrelated`)).status
      await realFetch(`${callback}?code=actual-code`)
    })()
  } }))
  expect(badPathStatus).toBe(404)
  expect(tokens.accessToken).toBe('session')
  expect(exchangeCalls).toBe(1)
})

it('accepts an encoded Cline token callback without posting its tokens as an exchange code', async () => {
  stubFetch(async () => { throw new Error('Token callback must not trigger an exchange') })
  const code = Buffer.from(JSON.stringify({ accessToken: 'encoded-access', refreshToken: 'encoded-refresh', email: 'test@example.com', expiresAt: 1900000000 })).toString('base64url')
  const tokens = await loginCline(callbacks({ onUpdate: (update) => {
    if (!update.url) return
    const callback = new URL(new URL(update.url).searchParams.get('callback_url')!)
    void realFetch(`${callback}?${new URLSearchParams({ code })}`)
  } }))
  expect(tokens).toMatchObject({ accessToken: 'encoded-access', refreshToken: 'encoded-refresh', expiresAt: 1900000000000, meta: { email: 'test@example.com' } })
})

it('rejects an explicit mismatched Cline state without exchanging the code', async () => {
  stubFetch(async () => { throw new Error('Must not exchange a mismatched callback') })
  await expect(loginCline(callbacks({ onUpdate: (update) => {
    if (!update.url) return
    const callback = new URL(new URL(update.url).searchParams.get('callback_url')!)
    void realFetch(`${callback}?code=code&state=wrong`)
  } }))).rejects.toThrow(/wrong state/)
})

it('sends a signed-in Cline request to the API endpoint with the WorkOS token scheme', async () => {
  saveAuthAccount({ id: 'auth:cline', kind: 'cline', label: 'Cline', createdAt: Date.now(), refreshable: true }, {
    accessToken: 'eyJheader.payload.signature', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000
  })
  let sentURL = ''
  let sentAuth = ''
  stubFetch(async (url, init) => {
    sentURL = String(url)
    sentAuth = authOf(init)
    return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  const output = []
  for await (const event of authProvider('auth:cline', 'nvidia/nemotron-3.5-lightning:free').chat({ system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 100, signal: new AbortController().signal })) output.push(event)
  expect(sentURL).toBe('https://api.cline.bot/api/v1/chat/completions')
  expect(sentAuth).toBe('Bearer workos:eyJheader.payload.signature')
  expect(output).toContainEqual({ type: 'text_delta', text: 'ok' })
})


it('blocks a paid model from an old Cline session before any network request', async () => {
  saveAuthAccount({ id: 'auth:cline', kind: 'cline', label: 'Cline', createdAt: Date.now(), refreshable: false }, { accessToken: 'token' })
  let calls = 0
  stubFetch(async () => { calls++; throw new Error('Must not request a paid model') })
  const run = async (): Promise<void> => {
    for await (const _event of authProvider('auth:cline', 'anthropic/claude-sonnet-4.6').chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(run()).rejects.toThrow('Paid models are disabled')
  expect(calls).toBe(0)
})

it('explains Cline product restrictions without retrying a paid equivalent', async () => {
  let calls = 0
  stubFetch(async () => {
    calls++
    return new Response(JSON.stringify({ error: { message: 'cline-free/muse-spark-1.3-contributor is only available via Cline product surfaces' } }), { status: 403, headers: { 'content-type': 'application/json' } })
  })
  const run = async (): Promise<void> => {
    for await (const _event of authProvider('auth:cline', 'nvidia/nemotron-3.5-lightning:free').chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(run()).rejects.toMatchObject({ status: 403, message: expect.stringContaining('official apps') })
  expect(calls).toBe(1)
  await expect(run()).rejects.toMatchObject({ status: 403 })
  expect(calls).toBe(1)
})

for (const [promotion, route] of [
  ['cline-free/minimax-m3.1-flash', 'minimax/minimax-m3.1-flash:free'],
  ['cline-free/nemotron-3.5-super-vl', 'nvidia/nemotron-3.5-super-vl:free']
] as const) it(`recovers an old restricted ${promotion} session through its advertised public free route`, async () => {
  saveAuthAccount({ id: 'auth:cline', kind: 'cline', label: 'Cline', createdAt: Date.now(), refreshable: false }, { accessToken: 'fixture' })
  savePersistedSettings({ authModelCatalogues: { 'auth:cline': {
    models: [promotion, route], checkedAt: Date.now(), freeOnly: true,
    unavailable: { [promotion]: { reason: 'Official apps only', until: Date.now() + 60000 } }
  } } })
  const bodies: unknown[] = []
  stubFetch(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'ok'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  for await (const _event of authProvider('auth:cline', promotion).chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) { /* consume */ }
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ model: route })
})

it('uses CodeBuddy GET polling, reads stable account identity and renews the rotated grant', async () => {
  const requests: {url: string; method?: string}[] = []
  stubFetch(async (url, init) => {
    requests.push({url:String(url),method:init?.method ?? 'GET'})
    if (String(url).includes('/auth/state?platform=CLI')) return new Response(JSON.stringify({data:{state:'fixture-state',authUrl:'https://www.codebuddy.ai/auth/fixture'}}))
    if (String(url).includes('/auth/token?state=')) return new Response(JSON.stringify({code:0,data:{state:'fixture-state',accessToken:'first',refreshToken:'r1',expiresIn:3600}}))
    if (String(url).endsWith('/plugin/account')) return new Response(JSON.stringify({data:{uid:'user-1',email:'one@example.test'}}))
    if (String(url).endsWith('/auth/token/refresh')) {
      expect(new Headers(init?.headers).get('X-Refresh-Token')).toBe('r1')
      return new Response(JSON.stringify({data:{accessToken:'second',refreshToken:'r2',expiresIn:3600}}))
    }
    throw new Error('Unexpected fixture URL')
  })
  const tokens = await loginCodebuddy(callbacks())
  expect(tokens).toMatchObject({accessToken:'first',meta:{userId:'user-1',email:'one@example.test'}})
  expect(requests[1]).toMatchObject({method:'GET',url:'https://www.codebuddy.ai/v2/plugin/auth/token?state=fixture-state'})
  expect(await refreshCodebuddy(tokens)).toMatchObject({accessToken:'second',refreshToken:'r2',meta:{userId:'user-1'}})
})
it('connects an OpenCode Go key without using a Zen or PAYG endpoint', async () => {
  const urls: string[] = []
  stubFetch(async (url) => { urls.push(String(url)); return new Response(JSON.stringify({data:[{id:'kimi-k3'}]})) })
  const tokens = await loginOpenCodeGo(callbacks({promptForCode:async()=> 'fixture-go-key'}))
  expect(tokens.accessToken).toBe('fixture-go-key')
  expect(urls).toEqual(['https://opencode.ai/inference/go/v1/models'])
})

it('uses the CodeBuddy account endpoint and completes a tool round trip without an API-key/PAYG fallback', async () => {
  saveAuthAccount({id:'auth:codebuddy-tools',kind:'codebuddy',label:'CodeBuddy fixture',createdAt:Date.now(),refreshable:false},{accessToken:'fixture-codebuddy'})
  const requests: {url:string;body:Record<string,unknown>}[]=[]
  stubFetch(async (url,init)=>{
    const headers=new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer fixture-codebuddy')
    expect(headers.get('user-agent')).toBe('anticode')
    expect(headers.get('X-Conversation-ID')).toBe('cb-session')
    expect(headers.get('X-Conversation-Request-ID')).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers.get('X-Conversation-Message-ID')).toMatch(/^[0-9a-f-]{36}$/)
    const first=requests.length===0
    requests.push({url:String(url),body:JSON.parse(String(init?.body))})
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:first?{tool_calls:[{index:0,id:'cb-call',type:'function',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]}:{content:'Done'},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  })
  const client=authProvider('auth:codebuddy-tools','default-model')
  const params: import('../providers/types').ChatParams={sessionId:'cb-session',system:'',messages:[{role:'user',content:[{type:'text',text:'Read a.txt'}]}],tools:[{name:'read_file',description:'Read a file',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']}}],maxTokens:128,signal:new AbortController().signal}
  const collect=async():Promise<import('../providers/types').LLMResponse>=>{
    for await(const event of client.chat(params))if(event.type==='response')return event.response
    throw new Error('No response')
  }
  const first=await collect()
  expect(first.stopReason).toBe('tool_use')
  params.messages.push({role:'assistant',content:first.content},{role:'user',content:[{type:'tool_result',toolUseId:'cb-call',content:'file contents',isError:false}]})
  expect((await collect()).content).toContainEqual({type:'text',text:'Done'})
  expect(requests.map(request=>request.url)).toEqual(['https://www.codebuddy.ai/v2/chat/completions','https://www.codebuddy.ai/v2/chat/completions'])
  expect(JSON.stringify(requests[1]?.body)).toContain('file contents')
})

it('explains CodeBuddy channel refusal without renewing tokens or exposing the raw response', async () => {
  saveAuthAccount({id:'auth:codebuddy-gate',kind:'codebuddy',label:'Fixture',createdAt:Date.now(),refreshable:true},{accessToken:'fixture',refreshToken:'refresh'})
  const urls: string[] = []
  stubFetch(async (url) => {
    urls.push(String(url))
    return new Response(JSON.stringify({ code: 11128, msg: 'request illegal', displayTips: { en: 'This call failed channel verification, possibly because it was not sent from an official client.' } }), { status: 400 })
  })
  const drain = async () => { for await (const _ of authProvider('auth:codebuddy-gate','default-model').chat({sessionId:'gate',system:'',messages:[],tools:[],maxTokens:16,signal:new AbortController().signal})) { /* consume */ } }
  await expect(drain()).rejects.toMatchObject({ status: 403, message: expect.stringContaining('Renew token tidak mengatasi') })
  expect(urls).toEqual(['https://www.codebuddy.ai/v2/chat/completions'])
})

it('automatically refreshes a CodeBuddy token rejected with 401 and retries once before output', async () => {
  saveAuthAccount({id:'auth:codebuddy-expired',kind:'codebuddy',label:'Fixture',createdAt:Date.now(),refreshable:true},{accessToken:'old',refreshToken:'r1'})
  const urls: string[] = []
  stubFetch(async (url, init) => {
    urls.push(String(url))
    if (String(url).endsWith('/token/refresh')) return new Response(JSON.stringify({data:{accessToken:'fresh',refreshToken:'r2',expiresAt:Math.floor(Date.now()/1000)+3600}}))
    if (new Headers(init?.headers).get('authorization') === 'Bearer old') return new Response(JSON.stringify({error:{message:'Unauthorized'}}),{status:401})
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  })
  const events = []
  for await (const event of authProvider('auth:codebuddy-expired','default-model').chat({sessionId:'expired',system:'',messages:[],tools:[],maxTokens:16,signal:new AbortController().signal})) events.push(event)
  expect(urls).toHaveLength(3)
  expect(events.at(-1)).toMatchObject({type:'response',response:{content:[{type:'text',text:'OK'}]}})
  expect(readAuthTokens('auth:codebuddy-expired')?.refreshToken).toBe('r2')
  expect(readAuthTokens('auth:codebuddy-expired')?.expiresAt).toBeGreaterThan(Date.now())
})

it('runs OpenRouter PKCE login from a pasted code and keeps the returned identity', async () => {
  const { loginOpenRouter } = await import('./openrouter')
  let challenge = ''
  stubFetch(async (url, init) => {
    expect(url).toBe('https://openrouter.ai/api/v1/auth/keys')
    const body = JSON.parse(String(init?.body))
    const { makeChallenge } = await import('./pkce')
    expect(makeChallenge(body.code_verifier)).toBe(challenge)
    expect(body).toMatchObject({ code: 'fixture-openrouter-code', code_challenge_method: 'S256' })
    return Response.json({ key: 'fixture-key', user_id: 'fixture-user' })
  })
  const tokens = await loginOpenRouter(callbacks({ onUpdate: update => {
    const authorize = new URL(update.url!)
    expect(authorize.origin).toBe('https://openrouter.ai')
    expect(authorize.searchParams.get('callback_url')).toMatch(/^http:\/\/localhost:\d+\/openrouter\/.+/)
    challenge = authorize.searchParams.get('code_challenge') ?? ''
  }, promptForCode: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 'fixture-openrouter-code' } }))
  expect(tokens).toMatchObject({ accessToken: 'fixture-key', meta: { accountId: 'fixture-user' } })
})

it('finishes OpenRouter login from the localhost callback instead of the dashboard', async () => {
  const { loginOpenRouter } = await import('./openrouter')
  let callbackUrl = ''
  const exchange = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ code: 'callback-code' })
    return Response.json({ key: 'fixture-key' })
  })
  stubFetch(exchange)
  const work = loginOpenRouter(callbacks({ onUpdate: update => {
    if (update.url) callbackUrl = new URL(update.url).searchParams.get('callback_url') ?? ''
  }, promptForCode: () => new Promise(() => {}) }))
  await vi.waitFor(() => expect(callbackUrl).not.toBe(''))
  const target = new URL(callbackUrl)
  await fetch(`http://127.0.0.1:${target.port}${target.pathname}?code=callback-code`)
  await expect(work).resolves.toMatchObject({ accessToken: 'fixture-key' })
})

it.each(['https://openrouter.ai/settings/keys', 'sk-or-fixture'])('rejects a dashboard URL or API key instead of an OpenRouter approval code', async code => {
  const { loginOpenRouter } = await import('./openrouter')
  const exchange = vi.fn()
  stubFetch(exchange)
  await expect(loginOpenRouter(callbacks({ promptForCode: async () => code }))).rejects.toThrow(/authorization code/)
  expect(exchange).not.toHaveBeenCalled()
})

it('cancels a parked OpenRouter code prompt without an exchange', async () => {
  const { loginOpenRouter } = await import('./openrouter')
  const abort = new AbortController()
  const exchange = vi.fn()
  stubFetch(exchange)
  const work = loginOpenRouter(callbacks({ signal: abort.signal, promptForCode: () => new Promise(() => {}) }))
  abort.abort()
  await expect(work).rejects.toThrow(/cancelled/)
  expect(exchange).not.toHaveBeenCalled()
})

it('runs Kilo browser device login without inventing a refresh grant', async () => {
  const { loginKilo } = await import('./kilo')
  stubFetch(async (url, init) => {
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^anticode\//)
    return Response.json(url.endsWith('/codes') ? { code: 'device-code', verificationUrl: 'https://kilo.ai/auth/device?code=device-code', expiresIn: 300 } : { status: 'approved', token: 'fixture-kilo', userEmail: 'kilo@example.com' })
  })
  const tokens = await loginKilo(callbacks())
  expect(tokens).toEqual({ accessToken: 'fixture-kilo', expiresAt: 0, meta: { email: 'kilo@example.com' } })
})

it('cancels a pending Kilo device poll promptly', async () => {
  const { loginKilo } = await import('./kilo')
  const controller = new AbortController()
  stubFetch(async url => {
    if (url.endsWith('/codes')) return Response.json({ code: 'device-code', verificationUrl: 'https://kilo.ai/auth/device?code=device-code' })
    controller.abort()
    return new Response(null, { status: 202 })
  })
  await expect(loginKilo(callbacks({ signal: controller.signal }))).rejects.toThrow(/cancelled|aborted/i)
})

it('connects only a verified MiniMax Token Plan key and filters wallet-only aliases', async () => {
  const { loginMiniMaxPlan } = await import('./minimaxPlan')
  let requests = 0
  stubFetch(async url => {
    requests++
    expect(url).toBe('https://www.minimax.io/v1/token_plan/remains')
    return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'MiniMax-M3' }, { model_name: 'MiniMax-M2.7-highspeed' }] })
  })
  await expect(loginMiniMaxPlan(callbacks({ promptForCode: async () => 'sk-wallet-fixture' }))).rejects.toThrow(/sk-cp/)
  expect(requests).toBe(0)
  const tokens = await loginMiniMaxPlan(callbacks({ promptForCode: async () => 'sk-cp-fixture' }))
  expect(JSON.parse(tokens.meta?.planModels ?? '[]')).toEqual(['MiniMax-M3'])
  expect(tokens.refreshToken).toBeUndefined()
})

it('connects an M Plan key whose remains lists no per-model rows, on M3.1 Flash', async () => {
  const { loginMiniMaxPlan } = await import('./minimaxPlan')
  stubFetch(async () => Response.json({ base_resp: { status_code: 0, status_msg: 'success' } }))
  const tokens = await loginMiniMaxPlan(callbacks({ promptForCode: async () => 'sk-cp-fixture' }))
  expect(JSON.parse(tokens.meta?.planModels ?? '[]')).toEqual(['MiniMax-M3.1-Flash'])
})

it("shows MiniMax's own reason when it refuses a Subscription Key", async () => {
  const { loginMiniMaxPlan } = await import('./minimaxPlan')
  stubFetch(async () => Response.json({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }))
  await expect(loginMiniMaxPlan(callbacks({ promptForCode: async () => 'sk-cp-fixture' }))).rejects.toThrow(/invalid api key.*1004/)
})

it('keeps ClinePass subscription identity and selected plan models across token refresh', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({success:true,data:{accessToken:'next-access',refreshToken:'next-refresh',email:'plan@example.test'}})))
  const next = await refreshCline({accessToken:'old-access',refreshToken:'old-refresh',meta:{accountId:'subscription-identity',planModels:'["cline-pass/test"]'}})
  expect(next.meta).toMatchObject({accountId:'subscription-identity',planModels:'["cline-pass/test"]'})
})
