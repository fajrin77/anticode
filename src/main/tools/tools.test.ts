import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { listDirectoryTool } from './listDirectory'
import { runCommandTool } from './runCommand'
import { resolveInWorkspace } from './workspace'
import type { ToolContext } from './types'

let root: string
let context: ToolContext

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-'))
  context = { workspaceRoot: root, signal: new AbortController().signal }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('generated input schemas', () => {
  it('omits $schema, which providers reject as an unknown key', () => {
    for (const tool of [readFileTool, writeFileTool, runCommandTool]) {
      expect(tool.inputSchema).not.toHaveProperty('$schema')
    }
  })

  it('leaves fields that have defaults out of required', () => {
    expect(runCommandTool.inputSchema['required']).toEqual(['command'])
    expect(listDirectoryTool.inputSchema['required']).toBeUndefined()
  })

  it('keeps genuinely mandatory fields required', () => {
    expect(editFileTool.inputSchema['required']).toEqual(['path', 'old_string', 'new_string'])
  })
})

describe('resolveInWorkspace', () => {
  it('allows nested paths', () => {
    expect(resolveInWorkspace(root, 'src/app.ts')).toBe(path.join(root, 'src/app.ts'))
  })

  it('rejects traversal above the root', () => {
    expect(() => resolveInWorkspace(root, '../secret.txt')).toThrow(/outside the workspace/)
  })

  it('rejects absolute paths outside the root', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(/outside the workspace/)
  })

  it('rejects a symlink pointing outside the root', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'anticode-outside-'))
    await writeFile(path.join(outside, 'secret.txt'), 'rahasia')
    await symlink(outside, path.join(root, 'link'))

    expect(() => resolveInWorkspace(root, 'link/secret.txt')).toThrow(/outside the workspace/)
    await rm(outside, { recursive: true, force: true })
  })
})

describe('read_file', () => {
  it('returns numbered lines', async () => {
    await writeFile(path.join(root, 'a.txt'), 'satu\ndua\ntiga')
    const output = (await readFileTool.prepare({ path: 'a.txt' }).execute(context)).text
    expect(output).toContain('    1\tsatu')
    expect(output).toContain('    3\ttiga')
  })

  it('honours offset and limit', async () => {
    await writeFile(path.join(root, 'a.txt'), 'satu\ndua\ntiga\nempat')
    const output = (await readFileTool.prepare({ path: 'a.txt', offset: 2, limit: 2 }).execute(context)).text
    expect(output).toContain('    2\tdua')
    expect(output).toContain('    3\ttiga')
    expect(output).not.toContain('satu')
    expect(output).toContain('1 more lines not shown')
  })

  it('reports a missing file as a tool error', async () => {
    await expect(readFileTool.prepare({ path: 'hilang.txt' }).execute(context)).rejects.toThrow(/Failed to read/)
  })

  it('rejects input that fails schema validation before anything runs', () => {
    expect(() => readFileTool.prepare({ path: 42 })).toThrow(/Invalid input/)
  })
})

describe('write_file', () => {
  it('creates missing parent directories', async () => {
    const output = (await writeFileTool
      .prepare({ path: 'src/nested/app.ts', content: 'export const a = 1\n' })
      .execute(context)).text
    expect(output).toContain('Saved')
    expect(await readFile(path.join(root, 'src/nested/app.ts'), 'utf8')).toBe(
      'export const a = 1\n'
    )
  })

  it('refuses to write outside the workspace', async () => {
    await expect(
      writeFileTool.prepare({ path: '../escape.txt', content: 'x' }).execute(context)
    ).rejects.toThrow(/outside the workspace/)
  })
})

describe('edit_file', () => {
  it('replaces a unique occurrence', async () => {
    await writeFile(path.join(root, 'a.txt'), 'halo dunia')
    await editFileTool.prepare({ path: 'a.txt', old_string: 'dunia', new_string: 'bumi' }).execute(context)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('halo bumi')
  })

  it('refuses when the target is ambiguous', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x\nx')
    await expect(
      editFileTool.prepare({ path: 'a.txt', old_string: 'x', new_string: 'y' }).execute(context)
    ).rejects.toThrow(/appears 2 times/)
  })

  it('refuses when the target is absent', async () => {
    await writeFile(path.join(root, 'a.txt'), 'halo')
    await expect(
      editFileTool.prepare({ path: 'a.txt', old_string: 'tidak ada', new_string: 'y' }).execute(context)
    ).rejects.toThrow(/not found/)
  })
})

describe('list_directory', () => {
  it('marks directories with a trailing slash', async () => {
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'README.md'), '#')
    const output = (await listDirectoryTool.prepare({ path: '.' }).execute(context)).text
    expect(output.split('\n')).toEqual(['README.md', 'src/'])
  })

  it('reports an empty directory', async () => {
    await mkdir(path.join(root, 'kosong'))
    expect((await listDirectoryTool.prepare({ path: 'kosong' }).execute(context)).text).toBe('(empty folder)')
  })
})

describe('run_command', () => {
  it('captures stdout and exit code', async () => {
    const output = (await runCommandTool.prepare({ command: 'echo halo' }).execute(context)).text
    expect(output).toContain('exit code 0')
    expect(output).toContain('halo')
  })

  it('reports a non-zero exit code with stderr', async () => {
    const output = (
      await runCommandTool.prepare({ command: 'echo gagal >&2; exit 3' }).execute(context)
    ).text
    expect(output).toContain('exit code 3')
    expect(output).toContain('gagal')
  })

  it('runs inside the workspace', async () => {
    await mkdir(path.join(root, 'sub'))
    const output = (await runCommandTool.prepare({ command: 'pwd', cwd: 'sub' }).execute(context)).text
    expect(output).toContain('sub')
  })

  it('refuses a working directory outside the workspace', async () => {
    await expect(runCommandTool.prepare({ command: 'pwd', cwd: '../..' }).execute(context)).rejects.toThrow(
      /outside the workspace/
    )
  })

  it('kills a command that exceeds its timeout', async () => {
    const output = (await runCommandTool
      .prepare({ command: 'sleep 5', timeout_ms: 1000 })
      .execute(context)).text
    expect(output).toContain('killed after 1000 ms')
  })

  it('does not hang when a background grandchild holds the stdio pipes', async () => {
    const started = Date.now()
    const output = (
      await runCommandTool.prepare({ command: 'sleep 8 & echo started' }).execute(context)
    ).text
    const elapsed = Date.now() - started
    expect(output).toContain('started')
    // The 8-second sleeper inherits the stdio pipes; the grace period must
    // return the result long before it exits, long before any timeout.
    expect(elapsed).toBeLessThan(5_000)
  })
})
