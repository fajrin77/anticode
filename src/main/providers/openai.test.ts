import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { OpenAICompatibleProvider } from './openai'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
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
