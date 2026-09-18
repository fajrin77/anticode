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
