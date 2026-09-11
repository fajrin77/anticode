import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-custom-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

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
