import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ file: '' as string | null, secure: true, moved: [] as string[] }))
vi.mock('./config', () => ({ envFilePath: () => state.file }))
vi.mock('./secrets', () => ({ secureStorageAvailable: () => state.secure }))
vi.mock('./providers/clinepass', () => ({ editClinepass: (edit: { apiKey: string }) => state.moved.push(edit.apiKey) }))

import { credentialStatus, mask, moveEnvKeys, parseEnv, restrictEnvFile } from './credentials'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'anticode-env-'))
  state.file = path.join(dir, '.env')
  state.secure = true
  state.moved = []
  await writeFile(state.file, [
    '# comment',
    'export CLINEPASS_API_KEY="sk-live-1234567890abcd"',
    'CLINEPASS_BASE_URL=https://api.cline.bot/api/v1',
    'GITHUB_TOKEN=ghp_abcdef1234567890 # personal',
    'EMPTY_TOKEN='
  ].join('\n'), { mode: 0o644 })
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('reads .env lines the way the loader does', () => {
  expect(parseEnv('export A="x y"\nB=z # note\n# C=no')).toEqual([
    { index: 0, name: 'A', value: 'x y' },
    { index: 1, name: 'B', value: 'z' }
  ])
  expect(mask('sk-live-1234567890abcd')).toBe('sk-l…abcd')
  expect(mask('short')).toBe('•••••')
})

it('lists the secrets in the file without their values, and whether others can read it', () => {
  const status = credentialStatus()
  expect(status.envKeys).toEqual([
    { name: 'CLINEPASS_API_KEY', masked: 'sk-l…abcd', usedBy: 'Clinepass', movable: true },
    { name: 'GITHUB_TOKEN', masked: 'ghp_…7890', usedBy: null, movable: false }
  ])
  expect(JSON.stringify(status)).not.toContain('1234567890abcd')
  expect(status.envFileOpen).toBe(process.platform !== 'win32')
})

it('moves the key anticode uses and leaves the rest of the file alone', async () => {
  moveEnvKeys()
  expect(state.moved).toEqual(['sk-live-1234567890abcd'])
  const text = await readFile(state.file as string, 'utf8')
  expect(text).not.toContain('sk-live')
  expect(text).toMatch(/# CLINEPASS_API_KEY moved to anticode's secure storage on \d{4}-\d{2}-\d{2}/)
  expect(text).toContain('CLINEPASS_BASE_URL=https://api.cline.bot/api/v1')
  expect(text).toContain('GITHUB_TOKEN=ghp_abcdef1234567890')
})

it('refuses to move keys with nowhere safe to put them', () => {
  state.secure = false
  expect(() => moveEnvKeys()).toThrow(/no secure storage/)
  expect(state.moved).toEqual([])
})

it('shuts other accounts out of the file on request', async () => {
  if (process.platform === 'win32') return
  await chmod(state.file as string, 0o644)
  restrictEnvFile()
  expect((await stat(state.file as string)).mode & 0o777).toBe(0o600)
})
