import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-custom-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  }
}))

import { addCustomProvider, cleanModelIds, updateCustomProvider, getCustomProvider, validatePreset } from './custom'

it('enforces free routes on add, edit and inference, including stale session ids', () => {
  const config = { label: 'Free', kind: 'openai' as const, preset: 'opencode-free' as const, baseURL: 'https://opencode.ai/zen/v1', apiKey: 'fixture', models: ['deepseek-v4.1-flash-free'] }
  const saved = addCustomProvider(config)
  expect(() => validatePreset(saved, 'deepseek-v4.1-flash')).toThrow(/free model routes only/)
  expect(() => validatePreset(saved, 'muse-spark-1.3-contributor-free')).toThrow(/free model routes only/)
  expect(() => addCustomProvider({ ...config, models: ['deepseek-v4.1-flash'] })).toThrow(/free model routes only/)
  expect(() => updateCustomProvider(saved.id, { models: ['deepseek-v4.1-flash'] })).toThrow(/free model routes only/)
  expect(() => updateCustomProvider(saved.id, { baseURL: 'https://other.test/v1' })).toThrow(/original provider endpoint/)
  updateCustomProvider(saved.id, { apiKey: 'renewed-fixture' })
  expect(getCustomProvider(saved.id)?.preset).toBe('opencode-free')
  expect(() => validatePreset({ ...saved, preset: 'openrouter-free', baseURL: 'https://openrouter.ai/api/v1' }, 'openrouter/free')).not.toThrow()
  expect(() => validatePreset({ ...saved, preset: 'kilo-free', baseURL: 'https://ai-gateway.kilo.ai/api/v1' }, 'paid/model')).toThrow(/free model routes only/)
})

it('reads model ids typed one per line or comma-separated, first one kept first', () => {
  expect(cleanModelIds('moonshotai/kimi-k3\n qwen/qwen3-coder , \n\nmoonshotai/kimi-k3')).toEqual([
    'moonshotai/kimi-k3',
    'qwen/qwen3-coder'
  ])
  expect(cleanModelIds(['a', ' b ', ''])).toEqual(['a', 'b'])
  expect(cleanModelIds(undefined)).toEqual([])
  expect(cleanModelIds(42)).toEqual([])
})

it('stores a vendor API under its own address when none was typed', () => {
  const anthropic = addCustomProvider({ label: 'Anthropic', kind: 'anthropic', baseURL: '', apiKey: 'sk-ant-x', models: [] })
  expect(anthropic.baseURL).toBe('https://api.anthropic.com')
  const openai = addCustomProvider({ label: 'OpenAI', kind: 'openai-api', baseURL: ' ', apiKey: 'sk-x', models: [] })
  expect(openai.baseURL).toBe('https://api.openai.com/v1')
  // A gateway has no address to fall back on.
  expect(() => addCustomProvider({ label: 'G', kind: 'openai', baseURL: '', apiKey: 'k', models: [] })).toThrow(/Base URL/)
  expect(() => addCustomProvider({ label: 'X', kind: 'nope' as 'openai', baseURL: 'https://x.dev', apiKey: 'k' })).toThrow(/Unknown provider type/)
})

it('encrypts API keys in the provider file while returning the usable value', () => {
  const provider = addCustomProvider({ label: 'Secure', kind: 'openai', baseURL: 'https://secure.test/v1', apiKey: 'secret-key', models: [] })
  expect(provider.apiKey).toBe('secret-key')
  expect(readFileSync(path.join(userData, 'providers.json'), 'utf8')).not.toContain('secret-key')
})

it('encrypts every API key, deduplicates additions and keeps them when editing unrelated fields', () => {
  const provider = addCustomProvider({label:'Pool',kind:'openai',baseURL:'https://pool.test/v1',apiKey:'first-secret',apiKeys:['second-secret','first-secret'],models:['coding']})
  expect(provider.apiKeys).toEqual(['first-secret','second-secret'])
  updateCustomProvider(provider.id,{label:'Renamed',apiKeys:['third-secret','second-secret']})
  updateCustomProvider(provider.id,{apiKey:'',models:['coding-new']})
  expect(getCustomProvider(provider.id)?.apiKeys).toEqual(['first-secret','second-secret','third-secret'])
  const stored=readFileSync(path.join(userData,'providers.json'),'utf8')
  for(const key of ['first-secret','second-secret','third-secret']) expect(stored).not.toContain(key)
  expect(JSON.parse(stored).providers.find((entry:{id:string})=>entry.id===provider.id).apiKeys.every((key:string)=>key.startsWith('safe:v1:'))).toBe(true)
})
