import { beforeEach, expect, it, vi } from 'vitest'
const { settings } = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))
vi.mock('./settings', () => ({ loadPersistedSettings: () => settings, savePersistedSettings: (patch: object) => Object.assign(settings, patch) }))
import { parseClaudeEffort, parseCodexEfforts, requestEffort, setModelEffort } from './effort'
import { effortFamily, modelEffort, ruleEffort } from '@shared/effort'
import { CodexProvider } from './providers/codex'

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key]
  vi.unstubAllGlobals()
})

it('offers each model family only the levels it accepts', () => {
  expect(ruleEffort('claude', 'claude-haiku-4-5')).toBeNull()
  expect(ruleEffort('claude', 'claude-sonnet-4-5')).toBeNull()
  expect(ruleEffort('claude', 'claude-opus-4-5')?.levels).toEqual(['low', 'medium', 'high'])
  expect(ruleEffort('claude', 'claude-opus-4-6')?.levels).toEqual(['low', 'medium', 'high', 'max'])
  expect(ruleEffort('claude', 'claude-opus-5-5')).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' })
  expect(ruleEffort('openai', 'gpt-5')?.levels).toEqual(['low', 'medium', 'high'])
  expect(ruleEffort('openai', 'gpt-6.1-sol')).toEqual({ levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' })
  expect(ruleEffort('openai', 'gpt-4.1')).toBeNull()
  expect(ruleEffort('gemini', 'gemini-2.5-flash')).toBeNull()
  expect(ruleEffort('gemini', 'gemini-3.5-flash')?.levels).toEqual(['low', 'high'])
})

it('gives no effort control to gateways or non-reasoning routes', () => {
  expect(effortFamily({ id: 'auth:openrouter', kind: 'auth', authKind: 'openrouter' }, 'openai/gpt-5')).toBeNull()
  expect(effortFamily({ id: 'auth:minimax', kind: 'auth', authKind: 'minimax-plan' }, 'MiniMax-M2')).toBeNull()
  expect(effortFamily({ id: 'auth:antigravity', kind: 'auth', authKind: 'antigravity' }, 'claude-sonnet-4-5')).toBeNull()
  expect(modelEffort({ id: 'auth:claude', kind: 'auth', authKind: 'claude' }, 'claude-opus-5')?.default).toBe('high')
})

it('prefers the levels the account reported over the built-in rules', () => {
  const provider = { id: 'auth:codex', kind: 'auth', authKind: 'codex', efforts: { 'gpt-6-luna': { levels: ['minimal', 'low', 'medium'], default: 'low' as const } } }
  expect(modelEffort(provider as never, 'gpt-6-luna')).toEqual({ levels: ['minimal', 'low', 'medium'], default: 'low' })
})

it('reads levels from the Codex and Anthropic catalogues', () => {
  expect(parseCodexEfforts({ models: [
    { slug: 'gpt-6-sol', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-chat', supported_reasoning_levels: [] }
  ] })).toEqual({ 'gpt-6-sol': { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } })
  expect(parseClaudeEffort({ id: 'claude-opus-5', capabilities: { effort: {
    supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: null, max: { supported: true }
  } } })).toEqual({ levels: ['low', 'medium', 'high', 'max'], default: 'high' })
  expect(parseClaudeEffort({ id: 'claude-haiku-4-5', capabilities: { effort: { supported: false } } })).toBeNull()
})

it('sends a picked level only when the model accepts it', () => {
  expect(requestEffort('claude', 'claude-opus-5')).toBeUndefined()
  setModelEffort('claude-opus-5', 'max')
  expect(requestEffort('claude', 'claude-opus-5')).toBe('max')
  setModelEffort('claude-opus-4-5', 'max')
  expect(requestEffort('claude', 'claude-opus-4-5')).toBeUndefined()
  setModelEffort('claude-opus-5', null)
  expect(requestEffort('claude', 'claude-opus-5')).toBeUndefined()
  expect(() => setModelEffort('claude-opus-5', 'turbo')).toThrow(/Unknown effort/)
})

it('puts the picked level on the Codex request and leaves it off by default', async () => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response('nope', { status: 400 })
  })
  const params = () => ({ system: '', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [], maxTokens: 100, signal: new AbortController().signal })
  const drain = async (): Promise<void> => { for await (const _ of new CodexProvider('at', 'gpt-6-sol').chat(params())) { /* consume */ } }
  await drain().catch(() => undefined)
  setModelEffort('gpt-6-sol', 'xhigh')
  await drain().catch(() => undefined)
  expect(bodies[0]).not.toHaveProperty('reasoning')
  expect(bodies[1]).toMatchObject({ reasoning: { effort: 'xhigh' } })
})
