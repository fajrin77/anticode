import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expandFolder, AttachmentError } from './index'

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-'))
  writeFileSync(path.join(root, 'index.ts'), 'export {}')
  writeFileSync(path.join(root, 'README.md'), '# hi')
  mkdirSync(path.join(root, 'node_modules/left-pad'), { recursive: true })
  writeFileSync(path.join(root, 'node_modules/left-pad/index.js'), 'junk')
  mkdirSync(path.join(root, '.git'))
  writeFileSync(path.join(root, '.git/config'), '[core]')
  mkdirSync(path.join(root, 'src/inner'), { recursive: true })
  writeFileSync(path.join(root, 'src/inner/util.ts'), 'export const one = 1')
  writeFileSync(path.join(root, 'logo.bin'), '\x00\x01\x02')
  return root
}

describe('expandFolder', () => {
  it('flattens a repo into its text files, skipping dependencies and VCS', async () => {
    const files = await expandFolder(repo(), [])
    const names = files.map((file) => file.path.split('/').pop()).sort()
    expect(names).toEqual(['README.md', 'index.ts', 'util.ts'])
  })

  it('does not add files it already knows', async () => {
    const root = repo()
    const known = await expandFolder(root, [])
    const again = await expandFolder(root, known)
    expect(again).toEqual([])
  })

  it('refuses a folder with nothing readable', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'empty-'))
    await expect(expandFolder(root, [])).rejects.toBeInstanceOf(AttachmentError)
  })
})
