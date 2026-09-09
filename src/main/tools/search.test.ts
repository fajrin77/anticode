import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDirectoryTool } from './listDirectory'
import { searchFilesTool } from './searchFiles'
import type { ToolContext } from './types'

let root: string
let context: ToolContext

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-search-'))
  context = { workspaceRoot: root, signal: new AbortController().signal }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('search_files', () => {
  it('finds matches with line numbers across files', async () => {
    await writeFile(path.join(root, 'a.ts'), 'const satu = 1\nconst dua = 2\n')
    await mkdir(path.join(root, 'sub'))
    await writeFile(path.join(root, 'sub', 'b.ts'), 'const tiga = 3\n')

    const output = (await searchFilesTool.prepare({ pattern: 'const ' }).execute(context)).text

    expect(output).toContain('a.ts')
    expect(output).toContain('    1\tconst satu = 1')
    expect(output).toContain('    2\tconst dua = 2')
    expect(output).toContain('sub/b.ts')
    expect(output).toContain('    1\tconst tiga = 3')
  })

  it('treats the pattern as plain text unless regex mode is on', async () => {
    await writeFile(path.join(root, 'a.ts'), 'foo.bar\nfooXbar\n')

    const literal = (await searchFilesTool.prepare({ pattern: 'foo.bar' }).execute(context)).text
    expect(literal).toContain('foo.bar')
    expect(literal).not.toContain('fooXbar')

    const regex = (
      await searchFilesTool.prepare({ pattern: 'foo.bar', is_regex: true }).execute(context)
    ).text
    expect(regex).toContain('foo.bar')
    expect(regex).toContain('fooXbar')
  })

  it('honours the glob filter', async () => {
    await writeFile(path.join(root, 'a.ts'), 'target\n')
    await writeFile(path.join(root, 'b.md'), 'target\n')

    const output = (
      await searchFilesTool.prepare({ pattern: 'target', glob: '*.md' }).execute(context)
    ).text

    expect(output).toContain('b.md')
    expect(output).not.toContain('a.ts')
  })

  it('skips ignored directories and binary files', async () => {
    await mkdir(path.join(root, 'node_modules', 'paket'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'paket', 'index.js'), 'target\n')
    await writeFile(path.join(root, 'biner.bin'), Buffer.from([0x00, 0x01, 0x02]))

    const output = (await searchFilesTool.prepare({ pattern: 'target' }).execute(context)).text

    expect(output).toContain('no matches')
  })

  it('refuses a search root outside the workspace', async () => {
    await expect(
      searchFilesTool.prepare({ pattern: 'x', path: '../..' }).execute(context)
    ).rejects.toThrow(/outside the workspace/)
  })
})

describe('list_directory ignore rules', () => {
  it('hides dependency and cache folders but says so', async () => {
    await mkdir(path.join(root, 'node_modules'))
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, '.DS_Store'), '')

    const output = (await listDirectoryTool.prepare({ path: '.' }).execute(context)).text

    expect(output).toContain('src/')
    expect(output).not.toContain('node_modules')
    expect(output).toContain('ignored')
  })
})
