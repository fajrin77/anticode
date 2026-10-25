import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
import { AntigravityProvider, antigravityResponse } from './antigravity'
import { CursorCliProvider, parseCursorModels, parseCursorReply } from './cursorCli'
import { antigravityModels, antigravityProject, refreshAntigravity } from '../auth/antigravity'
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
