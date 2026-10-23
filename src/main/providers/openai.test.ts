import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { OpenAICompatibleProvider } from './openai'
import type { ProviderEvent } from './types'

const servers: ReturnType<typeof createServer>[] = []

it('preserves tool identity when later stream chunks contain empty names and ids', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-kept', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }
    ]
    response.end(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  const provider = new OpenAICompatibleProvider('codebuddy', 'deepseek-v4.1-flash', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const events: ProviderEvent[] = []
  for await (const event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'response', response: { content: [{ type: 'tool_use', id: 'call-kept', name: 'read_file', input: { path: 'a.txt' } }] } })
})

it('rejects a cleanly closed stream with an unfinished tool call', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'write_file', arguments: '{"path":"a","content":"partial"}' } }] }, finish_reason: null }] }) + '\n\n')
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  const provider = new OpenAICompatibleProvider('fixture', 'fixture-model', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const events: ProviderEvent[] = []
  const consume = async () => { for await (const event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) events.push(event) }
  await expect(consume()).rejects.toMatchObject({ status: 503 })
  expect(events).toEqual([])
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

it('normalizes an explicit retired Cline free route carried inside HTTP 200 SSE', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const message = 'Failed to create stream: request failed with status 404: ' + JSON.stringify({ error: { message: 'The :free variant has been retired; use paid/model instead.', code: 404 }, user_id: 'private-fixture-account' })
    response.end('data: ' + JSON.stringify({ error: { code: 'stream_initialization_failed', message } }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  const provider = new OpenAICompatibleProvider('cline', 'minimax/model:free', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const consume = async () => { for await (const _ of provider.chat({ system: '', messages: [], tools: [], maxTokens: 128, signal: new AbortController().signal })) { /* consume */ } }
  await expect(consume()).rejects.toMatchObject({ status: 404, code: 'MODEL_ROUTE_RETIRED', scope: 'model' })
  await expect(consume()).rejects.not.toThrow(/private-fixture-account|paid\/model|user_id/)
})

it('fails over quickly when an OpenAI-compatible provider sends no first data', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.flushHeaders()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not open')

  const provider = new OpenAICompatibleProvider('silent', 'silent-model', {
    apiKey: 'fixture',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxTokensField: 'max_tokens',
    firstDataTimeoutMs: 40
  })
  const consume = async (): Promise<void> => {
    for await (const _event of provider.chat({
      system: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      maxTokens: 16,
      signal: new AbortController().signal
    })) { /* no event is expected */ }
  }

  await expect(consume()).rejects.toMatchObject({ message: 'Provider stream stalled before any data arrived', status: 503 })
})

it('generates a PNG through an OpenAI-compatible image endpoint', async () => {
  let requestBody = ''
  const server = createServer((request, response) => {
    request.on('data', (chunk) => { requestBody += String(chunk) })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ created: 1, output_format: 'png', data: [{ b64_json: 'aW1hZ2U=' }] }))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not open')
  const provider = new OpenAICompatibleProvider('images', 'chat-model', {
    apiKey: 'fixture',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxTokensField: 'max_tokens'
  })

  const generated = await provider.generateImage({
    prompt: 'A paper boat',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: 'medium',
    signal: new AbortController().signal
  })

  expect(generated).toEqual({ data: 'aW1hZ2U=', mediaType: 'image/png' })
  expect(JSON.parse(requestBody)).toMatchObject({
    prompt: 'A paper boat',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: 'medium',
    output_format: 'png'
  })
})


it('surfaces an upstream Cline rate limit carried inside HTTP 200 SSE', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ error: { code: 'stream_initialization_failed', message: 'Failed to create stream: request failed with status 429: upstream free pool rate limited' } }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  const provider = new OpenAICompatibleProvider('cline', 'test:free', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const consume = async (): Promise<void> => {
    for await (const _event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 128, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(consume()).rejects.toMatchObject({ status: 429 })
})

it.each(['cline', 'clinepass'])('normalizes %s nested upstream 429 behind a 404 without exposing raw metadata', async (name) => {
  let requests = 0
  const upstream = { error: { message: 'Provider returned error', code: 404, metadata: {
    raw: JSON.stringify({ error: 'please check the model you provided' }),
    previous_errors: [{ code: 429, message: 'Provider returned error', raw: 'poolside/laguna-xs-2.1:free is temporarily rate-limited upstream. Add your own key at https://openrouter.ai/settings/integrations' }]
  }, user_id: 'org_private-fixture' } }
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ error: { code: 'stream_initialization_failed', message: 'Failed to create stream: request failed with status 404: ' + JSON.stringify(upstream) } }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  const provider = new OpenAICompatibleProvider(name, 'poolside/laguna-xs-2.1:free', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const consume = async (): Promise<void> => {
    for await (const _event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 128, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(consume()).rejects.toMatchObject({
    status: 429, scope: 'model',
    message: 'This free model is temporarily rate limited upstream. Retry later or choose another free model.'
  })
  expect(requests).toBe(1)
})

it.each([
  { status: 404, detail: 'model not found', previous: [{ code: 429, message: 'an older attempt failed' }] },
  { status: 404, detail: 'temporarily rate-limited upstream', previous: [{ code: 404 }] },
  { status: 403, detail: 'only available via Cline product surfaces', previous: [{ code: 429, message: 'rate limited' }] }
])('preserves Cline status $status when no matching transient upstream failure exists', async ({ status, detail, previous }) => {
  const message = `Failed to create stream: request failed with status ${status}: ` + JSON.stringify({ error: { message: detail, metadata: { previous_errors: previous } } })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ error: { code: 'stream_initialization_failed', message } }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  const provider = new OpenAICompatibleProvider('cline', 'test:free', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const consume = async (): Promise<void> => {
    for await (const _event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 128, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(consume()).rejects.toMatchObject({ status, message })
})

it('does not report an empty stream as successful completion', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('No fixture address')
  const provider = new OpenAICompatibleProvider('cline', 'test:free', { apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  const consume = async (): Promise<void> => {
    for await (const _event of provider.chat({ system: '', messages: [], tools: [], maxTokens: 128, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(consume()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('no answer') })
})

it('rejects Laguna image history before calling the network, including on Continue', async () => {
  const provider = new OpenAICompatibleProvider('cline', 'poolside/laguna-xs-2.1:free', {
    apiKey: 'fixture', baseURL: 'http://127.0.0.1:1/v1', maxTokensField: 'max_tokens'
  })
  const run = async (): Promise<void> => {
    for await (const _event of provider.chat({ system: '', messages: [
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture' }] },
      { role: 'user', content: [{ type: 'text', text: 'lanjut' }] }
    ], tools: [], maxTokens: 16, signal: new AbortController().signal })) { /* consume */ }
  }
  await expect(run()).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Choose a vision model') })
})

it('retries OpenRouter once with the output budget the account can afford', async () => {
  const asked: number[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const maxTokens = JSON.parse(body).max_tokens as number
      asked.push(maxTokens)
      if (maxTokens > 9269) {
        response.writeHead(402, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 16000 tokens, but can only afford 9269.' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server did not open')
  const provider = new OpenAICompatibleProvider('openrouter', 'm', {
    apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens'
  })
  const events = []
  for await (const event of provider.chat({
    system: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [], maxTokens: 16000, signal: new AbortController().signal
  })) events.push(event)
  expect(asked).toEqual([16000, 8805])
  expect(events.some((event) => event.type === 'response')).toBe(true)
})

it('omits authorization for an explicitly anonymous free endpoint', async () => {
  let authorization: string | undefined
  const server = createServer((request, response) => {
    authorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture address')
  const provider = new OpenAICompatibleProvider('anonymous', 'fixture:free', { apiKey: 'anonymous', anonymous: true, baseURL: `http://127.0.0.1:${address.port}/v1`, maxTokensField: 'max_tokens' })
  for await (const _ of provider.chat({ system: '', messages: [], tools: [], maxTokens: 16, signal: new AbortController().signal })) { /* consume */ }
  expect(authorization).toBeUndefined()
})
