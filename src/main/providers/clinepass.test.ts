import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, expect, it, vi } from 'vitest'

const userData = mkdtempSync(path.join(tmpdir(), 'anticode-clinepass-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  }
}))

import { CLINEPASS_MODELS, isDirectClinepassURL, clinepassConfig, editClinepass, removeClinepass, restoreClinepass } from './clinepass'
import { createProvider, listProviders } from './index'
import { savePersistedSettings } from '../settings'
import { resetRotationForTests, rotationEntries, rotationGroups, rotationUsage } from '../rotation'

beforeAll(() => {
  process.env['CLINEPASS_API_KEY'] = 'env-key'
  process.env['CLINEPASS_BASE_URL'] = 'https://gateway.test/v1'
})

const clinepassRow = () => listProviders().find((entry) => entry.id === 'clinepass')

it('migrates an existing env connection into a normal locally stored provider', () => {
  expect(clinepassConfig()).toMatchObject({
    label: 'Clinepass', apiKey: 'env-key', baseURL: 'https://gateway.test/v1', models: CLINEPASS_MODELS, removed: false
  })
  expect(clinepassRow()).toMatchObject({ credentialAvailable: true, hasKey: true, baseURL: 'https://gateway.test/v1', kind: 'openai' })
})

it('takes edits from Settings over the env file, and blank fields keep what is there', () => {
  editClinepass({ label: 'Cline', apiKey: 'typed-key', baseURL: 'https://other.test/v1/chat/completions/', models: ['a', 'b'] })
  editClinepass({ label: '', apiKey: '  ', baseURL: '' })
  expect(clinepassConfig()).toMatchObject({ label: 'Cline', apiKey: 'typed-key', baseURL: 'https://other.test/v1', models: ['a', 'b'] })
  // The first typed model is where the provider starts.
  expect(clinepassRow()?.defaultModel).toBe('a')
  // The key is kept owner-only on disk and never handed to a viewer.
  expect(JSON.stringify(clinepassRow())).not.toContain('typed-key')
  expect(readFileSync(path.join(userData, 'providers.json'), 'utf8')).not.toContain('typed-key')
  expect(() => editClinepass({ baseURL: 'ftp://nope' })).toThrow('http or https')
})

it('goes back to the shipped models when the list is emptied', () => {
  editClinepass({ models: [] })
  expect(clinepassConfig().models).toEqual(CLINEPASS_MODELS)
})

it('is removed from every list, and restored with the env key', () => {
  removeClinepass()
  expect(clinepassRow()).toBeUndefined()
  restoreClinepass({})
  expect(clinepassConfig()).toMatchObject({ label: 'Clinepass', apiKey: 'env-key', baseURL: 'https://gateway.test/v1', removed: false })
  expect(clinepassRow()).toBeDefined()
})


it('classifies only the direct Clinepass service as a native plan route', () => {
  expect(isDirectClinepassURL('https://api.cline.bot/api/v1')).toBe(true)
  expect(isDirectClinepassURL('http://127.0.0.1:20128/v1')).toBe(false)
  expect(isDirectClinepassURL('https://api.cline.bot.evil.test/api/v1')).toBe(false)
  expect(isDirectClinepassURL('https://api.cline.bot/api/v1?proxy=external')).toBe(false)
})


it('repairs the legacy Muse casing in saved catalogues and existing session requests', () => {
  const legacy = 'cline-pass/Muse-Spark-1.3-contributor'
  const canonical = 'cline-pass/muse-spark-1.3-contributor'
  editClinepass({ models: [legacy, canonical] })
  expect(clinepassConfig().models).toEqual([canonical])
  expect(createProvider('clinepass', legacy).model).toBe(canonical)
  expect(CLINEPASS_MODELS).toContain(canonical)
})


it('migrates pooled Muse ids without losing usage or group membership', () => {
  const legacy = { provider: 'clinepass', model: 'cline-pass/Muse-Spark-1.3-contributor' }
  const canonical = { provider: 'clinepass', model: 'cline-pass/muse-spark-1.3-contributor' }
  savePersistedSettings({ rotation: {
    entries: [legacy, canonical],
    usage: {
      [`${legacy.provider}\n${legacy.model}`]: { inputTokens: 11, outputTokens: 2 },
      [`${canonical.provider}\n${canonical.model}`]: { inputTokens: 3, outputTokens: 1 }
    },
    groups: [{ id: 'coding', name: 'Coding', entries: [legacy] }]
  } })
  resetRotationForTests()
  expect(rotationEntries()).toEqual([canonical])
  expect(rotationGroups()[0]?.entries).toEqual([canonical])
  expect(rotationUsage(canonical)).toEqual({ inputTokens: 14, outputTokens: 3 })
})

it('has no default Clinepass connection on a fresh unconfigured profile', () => {
  removeClinepass()
  delete process.env.CLINEPASS_API_KEY
  delete process.env.CLINEPASS_BASE_URL
  expect(clinepassRow()).toBeUndefined()
})
