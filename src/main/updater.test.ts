import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareVersions, download, findLatest, macSwapScript, parseFeed, parseSource, pickAssetName, sha512Of } from './updater'

const mac = { os: 'darwin' as const, arch: 'arm64' }

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'anticode-update-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('update sources', () => {
  it('reads a repository, a feed URL, and a folder', () => {
    expect(parseSource('asani/anticode')).toEqual({ kind: 'github', repo: 'asani/anticode' })
    expect(parseSource('https://github.com/asani/anticode')).toEqual({ kind: 'github', repo: 'asani/anticode' })
    expect(parseSource('https://example.com/builds/latest-mac.yml')).toEqual({ kind: 'feed', url: 'https://example.com/builds/latest-mac.yml' })
    expect(parseSource('/Users/me/anticode/release')).toEqual({ kind: 'folder', path: '/Users/me/anticode/release' })
    expect(parseSource('')).toBeNull()
    expect(parseSource('just words')).toBeNull()
  })

  it('orders versions numerically, a pre-release before its release', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBe(1)
    expect(compareVersions('v1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.0-beta', '1.2.0')).toBe(-1)
  })

  it('picks the build that fits this machine, a zip first on macOS', () => {
    const names = ['anticode-1.0.0-arm64.dmg', 'anticode-1.0.0-arm64.dmg.blockmap', 'anticode-1.0.0-x64.dmg', 'anticode-1.0.0-arm64-mac.zip', 'anticode Setup 1.0.0.exe']
    expect(pickAssetName(names, mac)).toBe('anticode-1.0.0-arm64-mac.zip')
    expect(pickAssetName(names.slice(0, 3), mac)).toBe('anticode-1.0.0-arm64.dmg')
    expect(pickAssetName(names, { os: 'win32', arch: 'x64' })).toBe('anticode Setup 1.0.0.exe')
    expect(pickAssetName(names, { os: 'linux', arch: 'x64' })).toBeNull()
  })

  it("reads electron-builder's feed", () => {
    const feed = parseFeed([
      'version: 0.0.24',
      'files:',
      '  - url: anticode-0.0.24-arm64.dmg',
      '    sha512: abc==',
      '    size: 10',
      'path: anticode-0.0.24-arm64.dmg',
      "releaseDate: '2026-09-11T00:00:00.000Z'"
    ].join('\n'))
    expect(feed).toEqual({ version: '0.0.24', files: [{ url: 'anticode-0.0.24-arm64.dmg', sha512: 'abc==' }], notes: null })
  })
})

describe('a folder of builds', () => {
  it('offers the newest one for this machine, with the checksum its feed lists', async () => {
    await writeFile(path.join(dir, 'anticode-0.0.23-arm64.dmg'), 'old')
    await writeFile(path.join(dir, 'anticode-0.0.24-arm64.dmg'), 'new')
    await writeFile(path.join(dir, 'anticode-0.0.25-x64.dmg'), 'other cpu')
    const sha = await sha512Of(path.join(dir, 'anticode-0.0.24-arm64.dmg'))
    await writeFile(path.join(dir, 'latest-mac.yml'), `version: 0.0.24\nfiles:\n  - url: anticode-0.0.24-arm64.dmg\n    sha512: ${sha}\n`)
    const found = await findLatest({ kind: 'folder', path: dir }, mac)
    expect(found).toMatchObject({ version: '0.0.24', name: 'anticode-0.0.24-arm64.dmg', sha512: sha })

    const into = path.join(dir, 'downloads')
    const file = await download(found!, into, () => {})
    expect(await readFile(file, 'utf8')).toBe('new')
  })

  it('throws away a download that does not match its checksum', async () => {
    await writeFile(path.join(dir, 'anticode-0.0.24-arm64.dmg'), 'tampered')
    const asset = { version: '0.0.24', location: path.join(dir, 'anticode-0.0.24-arm64.dmg'), name: 'anticode-0.0.24-arm64.dmg', sha512: 'bm90IGl0', notes: null }
    await expect(download(asset, path.join(dir, 'downloads'), () => {})).rejects.toThrow(/checksum/)
    await expect(readFile(path.join(dir, 'downloads', asset.name))).rejects.toThrow()
  })
})

it('writes a swap script that puts the old app back if the copy fails', () => {
  const script = macSwapScript(42, "/tmp/st'aged/anticode.app", '/Applications/anticode.app')
  expect(script).toContain('while kill -0 42')
  expect(script).toContain(`'/tmp/st'\\''aged/anticode.app'`)
  expect(script).toMatch(/mv '\/Applications\/anticode\.app' '\/Applications\/anticode\.app\.old'/)
  expect(script).toContain("mv '/Applications/anticode.app.old' '/Applications/anticode.app'")
})
