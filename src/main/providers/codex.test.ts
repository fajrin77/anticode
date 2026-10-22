import { expect, it, vi, afterEach } from 'vitest'
import { CodexProvider } from './codex'

afterEach(() => {
  vi.unstubAllGlobals()
})

function chatParams(): Parameters<CodexProvider['chat']>[0] {
  return {
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'halo' }] }],
    tools: [],
    maxTokens: 100,
    signal: new AbortController().signal
  }
}

async function drain(provider: CodexProvider): Promise<void> {
  for await (const _ of provider.chat(chatParams())) {
    // consume
  }
}

it('turns a model-not-supported 400 into advice to pick another model', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response('{"detail":"The \'gpt-5.1-codex-max\' model is not supported when using Codex with a ChatGPT account."}', {
        status: 400
      })
  )
  await expect(drain(new CodexProvider('at', 'gpt-5.1-codex-max', 'acct_9'))).rejects.toThrow(
    /not available on this ChatGPT plan.*pick another Codex model/i
  )
})

it('keeps the raw backend error for anything else', async () => {
  vi.stubGlobal('fetch', async () => new Response('{"detail":"boom"}', { status: 500 }))
  await expect(drain(new CodexProvider('at', 'gpt-5.1-codex', 'acct_9'))).rejects.toThrow(/Codex returned 500/)
})

it('quota errors say to wait or rotate, not JSON', async () => {
  vi.stubGlobal('fetch', async () => new Response('{"detail":"quota"}', { status: 429 }))
  await expect(drain(new CodexProvider('at', 'gpt-5.5', 'acct_9'))).rejects.toThrow(/rate limited/)
})

it('preserves structured account quota and reset metadata for the native router', async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: reset } }), { status: 429 }))
  await expect(drain(new CodexProvider('at', 'gpt-6.1-sol'))).rejects.toMatchObject({ status: 429, scope: 'account', resetAt: reset * 1000 })
})

it('refuses an unfinished or failed stream instead of executing partial tool calls', async () => {
  vi.stubGlobal('fetch', async () => new Response('data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"t1","name":"apply_patch","arguments":"{}"}}\n\n'))
  await expect(drain(new CodexProvider('at', 'gpt-6.1-sol'))).rejects.toThrow(/before the response completed/)
  vi.stubGlobal('fetch', async () => new Response('data: {"type":"response.failed","response":{"error":{"message":"plan unavailable"}}}\n\n'))
  await expect(drain(new CodexProvider('at', 'gpt-6.1-sol'))).rejects.toThrow(/plan unavailable/)
})

it('reads a complete final SSE frame without a trailing newline', async () => {
  vi.stubGlobal('fetch', async () => new Response('data: {"type":"response.output_text.delta","delta":"halo"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":2}}}'))
  const events = []
  for await (const event of new CodexProvider('at', 'gpt-6.1-sol').chat(chatParams())) events.push(event)
  expect(events.at(-1)).toMatchObject({ type: 'response', response: { content: [{ type: 'text', text: 'halo' }], usage: { inputTokens: 8, outputTokens: 2 } } })
})
