import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeGoProvider } from './opencodeGo'
import type { ChatParams, LLMResponse } from './types'

afterEach(() => vi.unstubAllGlobals())
const frame = (data: unknown, event?: string): string => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`
const sse = (data: string): Response => new Response(data, { headers: { 'content-type': 'text/event-stream' } })
const params = (): ChatParams => ({ sessionId: 'conversation-one', system: 'Use tools', messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect a file and finish.' }] }], tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], maxTokens: 256, signal: new AbortController().signal })

for (const [model, protocol, path] of [
  ['kimi-k3', 'chat', '/openai/v1/chat/completions'],
  ['muse-spark-1.3-contributor', 'responses', '/openai/v1/responses'],
  ['minimax-m3', 'anthropic', '/anthropic/v1/messages'],
  ['gemini-4-argon-contributor', 'google', '/google/v1beta/models/gemini-4-argon-contributor:streamGenerateContent']
] as const) it(`uses the Go ${protocol} endpoint with stable session identity and a complete tool round trip`, async () => {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = []
  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
    const body = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body || '{}'))
    if (url.includes('/models/') && !url.includes('streamGenerateContent')) return new Response('{}', { status: 404 })
    const first = requests.length === 0
    requests.push({ url, body, headers })
    if (protocol === 'chat') return sse(frame({ choices: [{ index: 0, delta: first ? { tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } : { content: 'Done' }, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + 'data: [DONE]\n\n')
    if (protocol === 'responses') {
      const output = first ? [{ type: 'function_call', call_id: 'call-one', name: 'read_file', arguments: '{"path":"a.txt"}' }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }]
      return sse(frame({ type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 2 } } }))
    }
    if (protocol === 'google') return sse(frame({ candidates: [{ content: { role: 'model', parts: [first ? { functionCall: { id: 'call-one', name: 'read_file', args: { path: 'a.txt' } } } : { text: 'Done' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }))
    return sse(frame({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } }, 'message_start') +
      frame({ type: 'content_block_start', index: 0, content_block: first ? { type: 'tool_use', id: 'call-one', name: 'read_file', input: {} } : { type: 'text', text: '' } }, 'content_block_start') +
      frame({ type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } : { type: 'text_delta', text: 'Done' } }, 'content_block_delta') +
      frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop') +
      frame({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, 'message_delta') + frame({ type: 'message_stop' }, 'message_stop'))
  })
  const client = new OpenCodeGoProvider('fixture-key', model)
  const request = params()
  const consume = async (): Promise<LLMResponse> => {
    for await (const event of client.chat(request)) if (event.type === 'response') return event.response
    throw new Error('No completed response')
  }
  const first = await consume()
  expect(first.stopReason).toBe('tool_use')
  const call = first.content.find(block => block.type === 'tool_use')!
  expect(call).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } })
  if (call.type !== 'tool_use') throw new Error('Missing call')
  request.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'File contents', isError: false }] })
  expect((await consume()).content).toContainEqual({ type: 'text', text: 'Done' })
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request.url).toContain(`https://opencode.ai/inference/go${path}`)
    expect(request.headers.get('x-opencode-session')).toBe('conversation-one')
    expect(request.headers.get('user-agent')).toMatch(/(?:^|, )anticode\//)
    expect(JSON.stringify(request.body)).not.toContain('codex_cli_rs')
  }
  expect(JSON.stringify(requests[1]?.body)).toContain('File contents')
})

it('adds Anticode identity and stable session metadata to custom OpenCode requests', async () => {
  const { withOpenCodeSession, isOpenCodeEndpoint } = await import('./opencodeGo')
  const { OpenAICompatibleProvider } = await import('./openai')
  const seen: Headers[] = []
  vi.stubGlobal('fetch', async (input: Request | string | URL, init?: RequestInit) => {
    seen.push(new Headers(input instanceof Request ? input.headers : init?.headers))
    return sse(frame({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')
  })
  const client = withOpenCodeSession('minimax-m3.1-flash-free', 'https://opencode.ai/zen/go/v1', headers => new OpenAICompatibleProvider('custom', 'minimax-m3.1-flash-free', { apiKey: 'fixture', baseURL: 'https://opencode.ai/zen/go/v1', maxTokensField: 'max_tokens', ...(headers ? { defaultHeaders: headers } : {}) }))
  for (const system of ['Code task', 'You compact this conversation']) {
    for await (const _ of client.chat({ ...params(), system })) { /* consume */ }
  }
  expect(seen).toHaveLength(2)
  expect(seen.every(headers => headers.get('x-opencode-session') === 'conversation-one')).toBe(true)
  expect(seen.every(headers => headers.get('user-agent')?.startsWith('anticode/'))).toBe(true)
  expect(isOpenCodeEndpoint('https://opencode.ai.evil.test/zen/v1')).toBe(false)
  expect(isOpenCodeEndpoint('http://opencode.ai/zen/v1')).toBe(false)
})

it.each([
  ["OpenCode's free tier can only be used from within OpenCode.", /membatasi Free ke aplikasi resminya/],
  ['An active OpenCode Go subscription is required to use Go models.', /memerlukan subscription OpenCode Go aktif/]
] as const)('explains product access restrictions without retry or endpoint substitution: %s', async (message, expected) => {
  const { withOpenCodeSession } = await import('./opencodeGo')
  const fetcher = vi.fn(async () => Response.json({ error: { message } }, { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  const { OpenAICompatibleProvider } = await import('./openai')
  const baseURL = 'https://opencode.ai/zen/v1'
  const client = withOpenCodeSession('minimax-m3.1-flash-free', baseURL, headers => new OpenAICompatibleProvider('custom', 'minimax-m3.1-flash-free', { apiKey: 'fixture', baseURL, maxTokensField: 'max_tokens', ...(headers ? { defaultHeaders: headers } : {}) }))
  await expect((async () => { for await (const _ of client.chat(params())) { /* consume */ } })()).rejects.toThrow(expected)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
