import { afterEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ options: [] as Record<string, any>[], prompts: [] as any[], close: vi.fn(), mode: 'tool' }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: unknown) => options,
  query: ({ options, prompt }: { options: any; prompt: AsyncIterable<any> }) => {
    fixture.options.push(options)
    const iterator = (async function* () {
      if (fixture.mode === 'kept') {
        let turn = 0
        for await (const message of prompt) {
          fixture.prompts.push(message); turn++
          yield { type: 'assistant', message: { id: `kept-${turn}`, model: options.model, usage: { input_tokens: 5, output_tokens: 1 } } }
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `answer ${turn}` } } }
          yield { type: 'result', subtype: 'success', is_error: false, result: `answer ${turn}` }
        }
        return
      }
      if (fixture.mode === 'auth-error') {
        yield { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Token expired' }] } }; return
      }
      yield { type: 'assistant', message: { id: 'first', model: fixture.mode === 'wrong-model' ? 'claude-sonnet-5' : options.model, usage: { input_tokens: 12, output_tokens: 4 } } }
      if (fixture.mode === 'tool' || fixture.mode === 'parallel') {
        const calls = [options.mcpServers.anticode.tools[0].handler({ path: 'fixture.txt' })]
        if (fixture.mode === 'parallel') calls.push(options.mcpServers.anticode.tools[0].handler({ path: 'second.txt' }))
        for (const reply of await Promise.all(calls)) expect(reply.content[0].text).toBe('actual fixture result')
      }
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } } }
      yield { type: 'assistant', message: { id: 'second', model: options.model, usage: { input_tokens: 8, output_tokens: 2 } } }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    })()
    return Object.assign(iterator, { close: fixture.close })
  }
}))
import { ClaudeCodeProvider, claudeCodeEnvironment, claudeCodePrompt, unpackedClaudeExecutable } from './claudeCode'
import type { ChatParams, LLMResponse, ProviderEvent } from './types'

const controllers: AbortController[] = []
function params(): ChatParams {
  const controller = new AbortController(); controllers.push(controller)
  return { sessionId: crypto.randomUUID(), system: 'Anticode', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the fixture' }] }], tools: [{ name: 'read_file', description: 'Read a fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], maxTokens: 256, signal: controller.signal }
}
async function collect(provider: ClaudeCodeProvider, p: ChatParams): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []; for await (const event of provider.chat(p)) events.push(event); return events
}
const response = (events: ProviderEvent[]): LLMResponse => (events.find(e => e.type === 'response') as Extract<ProviderEvent, { type: 'response' }>).response
afterEach(() => { controllers.splice(0).forEach(c => c.abort()); fixture.options = []; fixture.prompts = []; fixture.close.mockClear(); fixture.mode = 'tool'; vi.unstubAllEnvs() })

it('passes only selected OAuth credentials and excludes ambient paid/router routes', () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-paid-key')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://localhost:20128')
  vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1')
  const env = claudeCodeEnvironment('fixture-oauth', '/tmp/fixture')
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fixture-oauth')
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toMatch(/^anticode\//)
})
it('resolves native engines outside Electron archives on macOS and Windows', () => {
  expect(unpackedClaudeExecutable('/App/Resources/app.asar/node_modules/claude')).toBe('/App/Resources/app.asar.unpacked/node_modules/claude')
  expect(unpackedClaudeExecutable('C:\\App\\app.asar\\node_modules\\claude.exe')).toBe('C:\\App\\app.asar.unpacked\\node_modules\\claude.exe')
})

it('preserves restored roles and original images without replaying display or signed blocks', () => {
  const p = params()
  p.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] }, { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'fixture-base64' }, { type: 'display', kind: 'notice', text: 'private UI notice' }] })
  const prompt = claudeCodePrompt(p)
  expect(JSON.stringify(prompt)).toContain('"role\\":\\"assistant')
  expect(JSON.stringify(prompt)).toContain('fixture-base64')
  expect(JSON.stringify(prompt)).not.toContain('private UI notice')
})

it('streams through the real SDK protocol while leaving tool execution to Anticode', async () => {
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  const first = response(await collect(provider, p))
  expect(first.stopReason).toBe('tool_use')
  const call = first.content.find(b => b.type === 'tool_use')!
  expect(call).toMatchObject({ name: 'read_file', input: { path: 'fixture.txt' } })
  p.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'actual fixture result', isError: false }] })
  const next = await collect(provider, p)
  expect(next).toContainEqual({ type: 'text_delta', text: 'OK' })
  expect(response(next)).toMatchObject({ stopReason: 'end_turn', content: [{ type: 'text', text: 'OK' }] })
  expect(fixture.options).toHaveLength(1)
  expect(fixture.options[0]).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, model: 'claude-sonnet-5-5' })
  expect(fixture.options[0]!.fallbackModel).toBeUndefined()
  expect(fixture.close).toHaveBeenCalled()
})

it('stops when the engine substitutes a different model', async () => {
  fixture.mode = 'wrong-model'
  await expect(collect(new ClaudeCodeProvider('fixture', 'claude-opus-5-5', 'fixture-token'), params())).rejects.toThrow(/different model/)
})
it('keeps authentication status available to the account refresh wrapper', async () => {
  fixture.mode = 'auth-error'
  await expect(collect(new ClaudeCodeProvider('fixture', 'claude-opus-5-5', 'fixture-token'), params())).rejects.toMatchObject({ status: 401 })
})
it('starts a fresh engine for the next user turn while the previous engine closes', async () => {
  fixture.mode = 'text'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  p.tools = []
  const first = response(await collect(provider, p))
  p.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'text', text: 'Continue' }] })
  expect(response(await collect(provider, p)).stopReason).toBe('end_turn')
  expect(fixture.options).toHaveLength(2)
})
it('restarts the engine when the tool list changes so newly loaded tools are callable', async () => {
  fixture.mode = 'tool'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  const first = response(await collect(provider, p))
  const call = first.content.find(b => b.type === 'tool_use')!
  p.tools = [...p.tools, { name: 'read_pdf', description: 'Read a pdf', inputSchema: { type: 'object', properties: {} } }]
  p.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'actual fixture result', isError: false }] })
  await collect(provider, p).catch(() => undefined)
  expect(fixture.options).toHaveLength(2)
  expect(fixture.options[1]?.mcpServers.anticode.tools.map((t: { name: string }) => t.name)).toContain('read_pdf')
})
it('returns concurrent tool proposals to the host and waits for both real results', async () => {
  fixture.mode = 'parallel'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  let tokens = 0
  for (let index = 0; index < 2; index++) {
    const result = response(await collect(provider, p)); tokens += result.usage.inputTokens
    const call = result.content.find(b => b.type === 'tool_use')!
    p.messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'actual fixture result', isError: false }] })
  }
  const final = response(await collect(provider, p)); tokens += final.usage.inputTokens
  expect(final.stopReason).toBe('end_turn')
  expect(tokens).toBe(20)
  expect(fixture.options).toHaveLength(1)
})

it('cancels a suspended tool without executing it outside the host loop', async () => {
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-opus-5-5', 'fixture-token')
  expect(response(await collect(provider, p)).stopReason).toBe('tool_use')
  controllers.at(-1)!.abort()
  expect(fixture.close).toHaveBeenCalled()
  await expect(collect(provider, p)).rejects.toThrow()
})

/** Plays one finished prompt and appends the answer plus the next user turn, like the Anticode loop. */
async function turn(provider: ClaudeCodeProvider, p: ChatParams, text: string): Promise<string> {
  p.messages.push({ role: 'user', content: [{ type: 'text', text }] })
  const answer = response(await collect(provider, p)).content.find(b => b.type === 'text')!
  p.messages.push({ role: 'assistant', content: [answer] })
  return (answer as { text: string }).text
}
function nextSignal(p: ChatParams): void { const c = new AbortController(); controllers.push(c); p.signal = c.signal }

it('keeps one engine across prompts of a session and sends only the new user turn', async () => {
  fixture.mode = 'kept'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  p.messages = []; p.tools = []
  expect(await turn(provider, p, 'first question')).toBe('answer 1')
  const firstSignal = p.signal
  nextSignal(p)
  expect(await turn(provider, p, 'second question')).toBe('answer 2')
  expect(fixture.options).toHaveLength(1)
  expect(fixture.prompts).toHaveLength(2)
  const second = JSON.stringify(fixture.prompts[1])
  expect(second).toContain('second question')
  expect(second).not.toContain('first question')
  // The finished prompt's signal no longer controls the parked engine.
  expect(firstSignal.aborted).toBe(false)
  expect(fixture.close).not.toHaveBeenCalled()
  // Usage stays per prompt, not cumulative.
  nextSignal(p)
  p.messages.push({ role: 'user', content: [{ type: 'text', text: 'third' }] })
  expect(response(await collect(provider, p)).usage.outputTokens).toBe(1)
})
it.each([
  ['the history is edited or compacted', (p: ChatParams) => { p.messages[0] = { role: 'user', content: [{ type: 'text', text: 'rewritten' }] } }],
  ['the history is rewound', (p: ChatParams) => { p.messages.splice(1) }],
  ['the system prompt changes', (p: ChatParams) => { p.system = 'Different' }],
  ['the output limit changes', (p: ChatParams) => { p.maxTokens = 4096 }],
  ['the tool list changes', (p: ChatParams) => { p.tools = [{ name: 'read_pdf', description: 'pdf', inputSchema: { type: 'object', properties: {} } }] }],
])('restarts from the transcript when %s', async (_name, change) => {
  fixture.mode = 'kept'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  p.messages = []; p.tools = []
  await turn(provider, p, 'one')
  nextSignal(p)
  change(p)
  p.messages.push({ role: 'user', content: [{ type: 'text', text: 'two' }] })
  await collect(provider, p)
  expect(fixture.options).toHaveLength(2)
  expect(fixture.close).toHaveBeenCalled()
  expect(JSON.stringify(fixture.prompts.at(-1))).toContain('two')
})
it('does not reuse a kept engine for another model or account token', async () => {
  fixture.mode = 'kept'
  const p = params()
  p.messages = []; p.tools = []
  await turn(new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'token-a'), p, 'one')
  nextSignal(p)
  await turn(new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'token-b'), p, 'two')
  nextSignal(p)
  await turn(new ClaudeCodeProvider('fixture', 'claude-opus-5-5', 'token-b'), p, 'three')
  expect(fixture.options).toHaveLength(3)
})
it('carries a tool run and the next prompt on the same engine', async () => {
  fixture.mode = 'tool'
  const p = params(), provider = new ClaudeCodeProvider('fixture', 'claude-sonnet-5-5', 'fixture-token')
  const first = response(await collect(provider, p))
  const call = first.content.find(b => b.type === 'tool_use')!
  p.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'actual fixture result', isError: false }] })
  const done = response(await collect(provider, p))
  expect(done.stopReason).toBe('end_turn')
  expect(fixture.options).toHaveLength(1)
})
