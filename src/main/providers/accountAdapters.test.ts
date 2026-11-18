import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
import { AntigravityProvider, antigravityResponse } from './antigravity'
import { CursorCliProvider, parseCursorModels, parseCursorReply } from './cursorCli'
import { antigravityModels, antigravityProject, refreshAntigravity } from '../auth/antigravity'
import { GEMINI_MODELS, geminiModels, geminiPlanInfo, refreshGemini } from '../auth/gemini'
import { GeminiCliProvider } from './geminiCli'
import { validCursorTokens } from '../auth/cursor'
import type { ChatParams, ProviderEvent } from './types'

const params = (): ChatParams => ({ system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }], maxTokens: 100, signal: new AbortController().signal })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('parses live Cursor model list without fabricated or auto aliases', () => {
  expect(parseCursorModels('Available models\n\u001b[36mgpt-test\u001b[0m - GPT Test (default)\nclaude-test - Claude Test\nauto - Auto\nTip: use --model')).toEqual(['gpt-test', 'claude-test'])
  expect(parseCursorModels('Authentication failed')).toEqual([])
})
it('Cursor emits tool requests for Anticode instead of executing them', () => {
  const result = parseCursorReply('{"text":"reading","tool_calls":[{"name":"read_file","arguments":{"path":"a"}}]}', params())
  expect(result.stopReason).toBe('tool_use')
  expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'read_file', input: { path: 'a' } })
  expect(() => parseCursorReply('{"tool_calls":[{"name":"execute_native_shell","arguments":{}}]}', params())).toThrow('unknown')
})
it('expired Cursor tokens require browser reauthorization', () => {
  expect(() => validCursorTokens({ accessToken: 'fixture', expiresAt: 1 })).toThrow('Sign in again')
})
it('Antigravity unwraps text, function calls and cache usage without exposing thoughts', () => {
  const result = antigravityResponse({ response: { candidates: [{ content: { parts: [{ text: 'private', thought: true }, { text: 'hello' }, { functionCall: { name: 'read_file', args: { path: 'a' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 50 } } }, 'gemini-fixture')
  expect(result.content).toHaveLength(2)
  expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'read_file' })
  expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cachedTokens: 50 })
})
it('Antigravity never provisions a Cloud project if activation is missing', async () => {
  const fetch = vi.fn(async () => Response.json({}))
  vi.stubGlobal('fetch', fetch)
  await expect(antigravityProject('fixture')).rejects.toThrow('will not create')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('Antigravity only offers supported enabled Gemini models reported by the account', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: { 'gemini-test': {}, 'gemini-disabled': { disabled: true }, 'claude-test': {} } })))
  expect(await antigravityModels({ accessToken: 'fixture', meta: { project: 'p' } })).toEqual(['gemini-test'])
})
it('Antigravity refresh keeps project and refresh token', async () => {
  vi.stubEnv('ANTICODE_ANTIGRAVITY_CLIENT_ID', 'fixture-client')
  vi.stubEnv('ANTICODE_ANTIGRAVITY_CLIENT_SECRET', 'fixture-secret')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'renewed', expires_in: 3600 })))
  const result = await refreshAntigravity({ accessToken: 'fixture', refreshToken: 'fixture-refresh', meta: { project: 'p' } })
  expect(result.accessToken).toBe('renewed')
  expect(result.refreshToken).toBe('fixture-refresh')
  expect(result.meta?.project).toBe('p')
})
it('Antigravity adapter uses direct project envelope and returns Anticode events', async () => {
  const fetch = vi.fn(async () => Response.json({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }))
  vi.stubGlobal('fetch', fetch)
  const events: ProviderEvent[] = []
  for await (const e of new AntigravityProvider({ accessToken: 'fixture', meta: { project: 'p' } }, 'gemini-test').chat(params())) events.push(e)
  expect(events.map((e) => e.type)).toEqual(['text_delta', 'response'])
  const request = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(request[0]).toContain(':generateContent')
  expect(JSON.parse(request[1].body as string)).toMatchObject({ project: 'p', model: 'gemini-test', request: { generationConfig: { maxOutputTokens: 100 } } })
})
it('Cursor image requests fail explicitly before running a native process', async () => {
  const input = params()
  input.messages = [{ role: 'user', content: [{ type: 'image', data: 'fixture', mediaType: 'image/png' }] }]
  const iterator = new CursorCliProvider('fixture', 'test').chat(input)
  await expect(iterator.next()).rejects.toThrow('text and tool')
})
it('Gemini plan streams text and keeps whole function calls, without repeating the text', async () => {
  const sse = [
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"rea"}]}}]}}',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ding"}]}}]}}',
    'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"a"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}}'
  ].join('\n\n') + '\n\n'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })))
  const events: ProviderEvent[] = []
  for await (const e of new GeminiCliProvider({ accessToken: 'fixture', meta: { project: 'p' } }, 'gemini-test').chat(params())) events.push(e)
  expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')).toBe('reading')
  const response = events.at(-1) as { type: string; response: { content: unknown[]; usage: unknown } }
  expect(response.type).toBe('response')
  expect(response.response.content).toEqual([{ type: 'tool_use', id: expect.stringMatching(/^gen-/), name: 'read_file', input: { path: 'a' } }])
  expect(response.response.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedTokens: 0 })
  const request = (vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])
  expect(request[0]).toContain('streamGenerateContent?alt=sse')
  expect(JSON.parse(request[1].body as string)).toMatchObject({ model: 'gemini-test', project: 'p', request: { generationConfig: { maxOutputTokens: 100 } } })
})
it('Gemini plan keeps the CLI model list when a consumer plan refuses the catalogue route', async () => {
  // A Google AI Plus account gets 403 from fetchAvailableModels; that is not a
  // reason to show an empty Models page.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"PERMISSION_DENIED"}', { status: 403 })))
  const models = await geminiModels({ accessToken: 'fixture', meta: { project: 'p' } })
  expect(models).toContain('gemini-3.5-flash-lite')
  expect(models).toContain('gemini-3.5-flash')
  expect(models.some((model) => model.includes('embedding'))).toBe(GEMINI_MODELS.some(() => false))
})
it('Gemini plan merges what the catalogue does report, without embeddings or disabled models', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: { 'gemini-9-pro': {}, 'gemini-embedding-001': {}, 'gemini-old': { disabled: true } } })))
  const models = await geminiModels({ accessToken: 'fixture', meta: { project: 'p' } })
  expect(models).toContain('gemini-9-pro')
  expect(models).not.toContain('gemini-old')
  expect(models.some((model) => model.includes('embedding'))).toBe(false)
})
it('Gemini plan onboards once when the plan has no project yet, and never invents one', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const method = String(url).split('v1internal:')[1] ?? ''
    calls.push(method)
    if (method === 'loadCodeAssist') return Response.json({ allowedTiers: [{ id: 'free-tier', name: 'Gemini Code Assist', isDefault: true }] })
    if (method === 'onboardUser') return Response.json({ done: true, response: { cloudaicompanionProject: { id: 'managed-1' } } })
    return new Response('{}', { status: 500, headers: { 'content-type': 'text/plain' } })
  }))
  expect(await geminiPlanInfo('fixture')).toEqual({ project: 'managed-1', tier: 'Gemini Code Assist' })
  expect(calls).toEqual(['loadCodeAssist', 'onboardUser'])
})
it('Gemini plan refresh keeps the assigned project', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'renewed', expires_in: 3600 })))
  const result = await refreshGemini({ accessToken: 'fixture', refreshToken: 'fixture-refresh', meta: { project: 'p' } })
  expect(result.accessToken).toBe('renewed')
  expect(result.refreshToken).toBe('fixture-refresh')
  expect(result.meta?.project).toBe('p')
})
