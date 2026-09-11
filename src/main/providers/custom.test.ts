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

import { addCustomProvider, cleanModelIds } from './custom'

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
