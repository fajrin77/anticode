import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { AnthropicProvider, CLAUDE_CODE_HEADERS, anthropicBaseURL } from './anthropic'
import { chatModelsOnly } from './models'
import type { ProviderEvent } from './types'

/** Requests the stub saw: the model looked up, and the max_tokens each message asked for. */
const seen: { lookups: string[]; maxTokens: number[]; bodies: Record<string, unknown>[] } =
  { lookups: [], maxTokens: [], bodies: [] }

const stub = createServer(async (req, res) => {
  const lookup = /^\/v1\/models\/(.+)$/.exec(req.url ?? '')
  if (req.method === 'GET' && lookup !== null) {
    const id = decodeURIComponent(lookup[1] ?? '')
    seen.lookups.push(id)
    if (id === 'unknown-model') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'no such model' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z',
      max_input_tokens: 200_000, max_tokens: id === 'claude-small' ? 4096 : 128_000
    }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw) as { model: string; max_tokens: number }
  seen.maxTokens.push(body.max_tokens)
  seen.bodies.push(body as unknown as Record<string, unknown>)
  if (body.model === 'missing-model') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: missing-model' } }))
    return
  }
  if (body.model === 'limited-model') {
    res.writeHead(429, {
      'content-type': 'application/json',
      'anthropic-ratelimit-requests-reset': '2026-09-19T00:01:00Z',
      'request-id': 'req_test123'
    })
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
    return
  }
  if (body.model === 'locked-model') {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid_token' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  send('message_start', { type: 'message_start', message: {
    id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 }
  } })
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hai' } })
  send('content_block_stop', { type: 'content_block_stop', index: 0 })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
  send('message_stop', { type: 'message_stop' })
  res.end()
})

let baseURL = ''
beforeAll(async () => {
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})
afterAll(() => { stub.close() })

async function ask(model: string, maxTokens = 32_000): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  // Pasted with /v1, as people do; the adapter must not call /v1/v1/…
  const provider = new AnthropicProvider('sk-ant-test', model, `${baseURL}/v1/`)
  for await (const event of provider.chat({
    system: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
    tools: [], maxTokens, signal: new AbortController().signal
  })) events.push(event)
  return events
}

it('lowers the output ask to what an older model allows, once per model', async () => {
  const first = await ask('claude-small')
  await ask('claude-small')
  expect(seen.maxTokens.slice(-2)).toEqual([4096, 4096])
  expect(seen.lookups.filter((id) => id === 'claude-small')).toHaveLength(1)
  expect(first.at(-1)).toMatchObject({
    type: 'response',
    response: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 }, content: [{ type: 'text', text: 'hai' }] }
  })
})

it('keeps the loop’s ask for a model that allows more, or one it cannot look up', async () => {
  await ask('claude-large')
  expect(seen.maxTokens.at(-1)).toBe(32_000)
  await ask('unknown-model')
  expect(seen.maxTokens.at(-1)).toBe(32_000)
})

it('takes a Base URL with or without /v1', () => {
  expect(anthropicBaseURL('https://api.anthropic.com/v1/')).toBe('https://api.anthropic.com')
  expect(anthropicBaseURL('https://api.anthropic.com')).toBe('https://api.anthropic.com')
})

it('leaves out of OpenAI’s list the models that cannot chat', () => {
  expect(chatModelsOnly(['gpt-5', 'text-embedding-3-large', 'tts-1', 'whisper-1', 'dall-e-3', 'omni-moderation-latest', 'gpt-5-mini']))
    .toEqual(['gpt-5', 'gpt-5-mini'])
})

it('puts a cache breakpoint on the system prompt and the last tool', async () => {
  const events: ProviderEvent[] = []
  const provider = new AnthropicProvider('sk-ant-test', 'claude-large', baseURL)
  for await (const event of provider.chat({
    system: 'instruksi tetap',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
    tools: [
      { name: 'satu', description: 'a', inputSchema: { type: 'object' } },
      { name: 'dua', description: 'b', inputSchema: { type: 'object' } }
    ],
    maxTokens: 1000,
    signal: new AbortController().signal
  })) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'response' })

  const body = seen.bodies.at(-1) as {
    system: { cache_control?: unknown }[]
    tools: { name: string; cache_control?: unknown }[]
  }
  expect(body.system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
  expect(body.tools[0]?.cache_control).toBeUndefined()
  expect(body.tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
})

async function failsWith(model: string): Promise<string> {
  const provider = new AnthropicProvider('sk-ant-test', model, baseURL)
  try {
    for await (const _ of provider.chat({
      system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
      tools: [], maxTokens: 100, signal: new AbortController().signal
    })) {
      // consume
    }
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('chat did not fail')
}

it('names a usable model when the id does not exist', async () => {
  expect(await failsWith('missing-model')).toMatch(/does not exist on this account/)
})

it('quota errors say to wait or rotate, not JSON', async () => {
  expect(await failsWith('limited-model')).toMatch(/rate limited/)
})

it('rate-limit wording never trips the spent-quota detector', async () => {
  const { isOutOfUsage } = await import('../usageErrors')
  expect(isOutOfUsage(new Error(await failsWith('limited-model')))).toBe(false)
})

it('carries the vendor reset timestamps so the transcript settles quota vs throttle', async () => {
  expect(await failsWith('limited-model')).toMatch(/limits reset requests=.*req_test123/)
})

it('leaves 401s alone so the OAuth wrapper can retry them', async () => {
  expect(await failsWith('locked-model')).toMatch(/401/)
})

it('sends the CLI identity headers OAuth traffic needs', async () => {
  const seen: Record<string, string | string[] | undefined>[] = []
  const srv = createServer((req, res) => {
    seen.push({ ...req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    send('message_start', { type: 'message_start', message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }
    } })
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    const provider = new AnthropicProvider('', 'claude-sonnet-5', base, {
      authToken: 'oauth-at',
      defaultHeaders: CLAUDE_CODE_HEADERS
    })
    for await (const _ of provider.chat({
      system: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
      tools: [], maxTokens: 10, signal: new AbortController().signal
    })) {
      // consume
    }
  } finally {
    srv.close()
  }
  const headers = seen.at(-1) ?? {}
  expect(headers['authorization']).toBe('Bearer oauth-at')
  for (const [name, value] of Object.entries(CLAUDE_CODE_HEADERS)) {
    expect(String(headers[name] ?? '')).toBe(value)
  }
})
