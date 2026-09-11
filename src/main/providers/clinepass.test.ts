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

import { CLINEPASS_MODELS, clinepassConfig, editClinepass, removeClinepass, restoreClinepass } from './clinepass'
import { listProviders } from './index'

beforeAll(() => {
  process.env['CLINEPASS_API_KEY'] = 'env-key'
  process.env['CLINEPASS_BASE_URL'] = 'https://gateway.test/v1'
})

const clinepassRow = () => listProviders().find((entry) => entry.id === 'clinepass')

it('starts from the env file and the shipped model list', () => {
  expect(clinepassConfig()).toMatchObject({
    label: 'Clinepass', apiKey: 'env-key', baseURL: 'https://gateway.test/v1', models: CLINEPASS_MODELS, removed: false
  })
  expect(clinepassRow()).toMatchObject({ credentialAvailable: true, hasKey: true, baseURL: 'https://gateway.test/v1', kind: 'clinepass' })
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
