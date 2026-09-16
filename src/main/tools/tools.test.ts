import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { listDirectoryTool } from './listDirectory'
import { runCommandTool } from './runCommand'
import { activeWebUrl, listWeb } from '../web'
import { resolveInWorkspace } from './workspace'
import type { ToolContext } from './types'
import { todoWriteTool } from './todoWrite'
import { shareFileTool } from './shareFile'
import { subagentTools, toolsFor } from './index'

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

describe('todo_write', () => {
  it('renders a complete visible checklist', async () => {
    const output = await todoWriteTool.prepare({ items: [
      { content: 'Inspect', status: 'completed' },
      { content: 'Implement', status: 'in_progress' },
      { content: 'Verify', status: 'pending' }
    ] }).execute(context)
    expect(output.text).toBe('Task plan:\n[x] Inspect\n[>] Implement\n[ ] Verify')
  })

  it('rejects two simultaneously active tasks', async () => {
    await expect(todoWriteTool.prepare({ items: [
      { content: 'One', status: 'in_progress' },
      { content: 'Two', status: 'in_progress' }
    ] }).execute(context)).rejects.toThrow(/Only one/)
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

  // A dev server announcing its address is the whole reason the browser pane
  // exists, so the line is picked out of the output rather than waited on.
  it('opens the browser pane on a dev server it sees start', async () => {
    await runCommandTool
      .prepare({ command: 'echo "  Local:   http://localhost:4321/"' })
      .execute({ ...context, sessionId: 'run-command-session' })
    expect(activeWebUrl('run-command-session')).toBe('http://localhost:4321/')
  })

  it('leaves the pane alone when nothing was served', async () => {
    await runCommandTool
      .prepare({ command: 'echo "no server here"' })
      .execute({ ...context, sessionId: 'quiet-session' })
    expect(listWeb().some((entry) => entry.sessionId === 'quiet-session')).toBe(false)
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

it('rejects writing through a dangling symlink to an outside file', async () => {
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`)
  await symlink(outside, path.join(root, 'link.txt'))
  await expect(writeFileTool.prepare({path: 'link.txt', content: 'escape'}).execute(context)).rejects.toThrow(/symlink/)
  await expect(readFile(outside)).rejects.toThrow()
})
it('permits ordinary names beginning with two dots', () => {
  expect(resolveInWorkspace(root, '..config')).toBe(path.join(root, '..config'))
})

it('marks a nonzero command exit as a tool failure', async () => {
  const output = await runCommandTool.prepare({command: 'exit 7'}).execute(context)
  expect(output.isError).toBe(true)
  expect(output.text).toContain('exit code 7')
})
it('caps command output while reporting truncation', async () => {
  const output = await runCommandTool.prepare({command: 'node -e "process.stdout.write(\'x\'.repeat(200000))"'}).execute(context)
  expect(output.text.length).toBeLessThan(11000)
  expect(output.text).toContain('truncated')
})

describe('share_file', () => {
  it('hands over an existing file of any kind, with its size', async () => {
    await mkdir(path.join(root, 'release'))
    await writeFile(path.join(root, 'release', 'app Setup.exe'), Buffer.alloc(2048))
    const output = await shareFileTool.prepare({ path: 'release/app Setup.exe' }).execute(context)
    expect(output.isError).toBeUndefined()
    expect(output.text).toContain('release/app Setup.exe (2.0 KB)')
  })

  it('refuses a file that is not there, so no card is drawn for it', async () => {
    await expect(shareFileTool.prepare({ path: 'missing.exe' }).execute(context)).rejects.toThrow(/not found/)
  })

  it('refuses folders and paths outside the workspace', async () => {
    await mkdir(path.join(root, 'release'))
    await expect(shareFileTool.prepare({ path: 'release' }).execute(context)).rejects.toThrow(/folder/)
    await expect(shareFileTool.prepare({ path: '../outside.exe' }).execute(context)).rejects.toThrow(/outside/)
  })

  it('is available in both anticode and antichat, without approval', () => {
    expect(toolsFor('code').some((tool) => tool.name === 'share_file')).toBe(true)
    expect(toolsFor('chat').some((tool) => tool.name === 'share_file')).toBe(true)
    expect(shareFileTool.prepare({ path: 'a.exe' }).risk).toBe('low')
  })
})

describe('mode toolsets', () => {
  it('offers antichat and anticode the same tools', () => {
    expect(toolsFor('chat').map((tool) => tool.name)).toEqual(
      toolsFor('code').map((tool) => tool.name)
    )
  })

  // antichat is the mode people ask questions in, so the one tool that finds
  // a page rather than reading a known one has to be there — and a sub-agent
  // sent to look something up needs it more than the main agent does.
  it('gives both modes and every sub-agent a way to search the web', () => {
    expect(toolsFor('chat').some((tool) => tool.name === 'web_search')).toBe(true)
    expect(toolsFor('code').some((tool) => tool.name === 'web_search')).toBe(true)
    expect(subagentTools().some((tool) => tool.name === 'web_search')).toBe(true)
  })
})
