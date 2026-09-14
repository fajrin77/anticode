import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pruneOldDownloads } from './updates'

const root = path.join(tmpdir(), 'anticode-updates-test')
const dir = path.join(root, 'updates')

async function stage(name: string, content = 'x'): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, content)
  return file
}

vi.mock('electron', () => ({ app: { getPath: () => path.dirname(dir) }, BrowserWindow: {} }))

describe('pruneOldDownloads', () => {
  beforeEach(async () => {
    await mkdir(dir, { recursive: true })
    for (const entry of await readdir(dir)) {
      await rm(path.join(dir, entry), { recursive: true, force: true })
    }
  })

  it('removes every old build and keeps nothing when asked for nothing', async () => {
    await stage('anticode-1.0.0.dmg')
    await stage('anticode-1.1.0.dmg')
    await pruneOldDownloads()
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps only the staged build that is about to be installed', async () => {
    const keep = await stage('anticode-2.0.0.dmg', 'installer')
    await stage('anticode-1.0.0.dmg')
    await pruneOldDownloads('anticode-2.0.0.dmg')
    const left = await readdir(dir)
    expect(left).toEqual(['anticode-2.0.0.dmg'])
    expect((await stat(keep)).size).toBeGreaterThan(0)
  })

  it('survives a missing directory', async () => {
    await rm(dir, { recursive: true, force: true })
    await expect(pruneOldDownloads()).resolves.toBeUndefined()
  })
})
