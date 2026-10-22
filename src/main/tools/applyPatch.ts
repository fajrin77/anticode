import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { TRANSCRIPT_DIFF_CHARS, unifiedDiff } from './diff'

type Operation = { kind: 'Add' | 'Update' | 'Delete'; path: string; lines: string[] }

/** Strict Codex-style patch format. No shell execution or fuzzy replacements. */
function parse(patch: string): Operation[] {
  const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n')
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new ToolError('Patch must start with *** Begin Patch and end with *** End Patch')
  }
  const operations: Operation[] = []
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      operations.push({ kind: header[1] as Operation['kind'], path: header[2]!, lines: [] })
    } else {
      const current = operations.at(-1)
      if (!current || line.startsWith('*** ') && line !== '*** End of File') {
        throw new ToolError(`Unsupported patch line: ${line}. Moves are not supported; use add and delete.`)
      }
      current.lines.push(line)
    }
  }
  if (!operations.length) throw new ToolError('Patch contains no file changes')
  return operations
}

export function patchPaths(patch: string): string[] {
  return parse(patch).map((operation) => operation.path)
}

function update(original: string, body: string[]): string {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const trailing = original.endsWith('\n')
  let lines = original.replace(/\r\n/g, '\n').split('\n')
  if (trailing) lines.pop()
  let cursor = 0
  let index = 0
  let hunks = 0
  while (index < body.length) {
    if (!/^@@(?: .*)?$/.test(body[index]!)) throw new ToolError('Update hunks must start with @@')
    index++
    const before: string[] = []
    const after: string[] = []
    let eof = false
    while (index < body.length && !body[index]!.startsWith('@@')) {
      const line = body[index++]!
      if (line === '*** End of File') {
        eof = true
        if (index !== body.length) throw new ToolError('End of File must be the final hunk line')
        break
      }
      if (![' ', '+', '-'].includes(line[0] ?? '')) throw new ToolError('Hunk lines must start with space, +, or -')
      if (line[0] !== '+') before.push(line.slice(1))
      if (line[0] !== '-') after.push(line.slice(1))
    }
    if (!before.length) throw new ToolError('An update needs existing context; use Add File for a new file')
    const matches: number[] = []
    for (let at = cursor; at <= lines.length - before.length; at++) {
      if (eof && at + before.length !== lines.length) continue
      if (before.every((line, offset) => lines[at + offset] === line)) matches.push(at)
    }
    if (matches.length !== 1) throw new ToolError(`Patch context matched ${matches.length} locations; include unique surrounding lines`)
    const at = matches[0]!
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + before.length)]
    cursor = at + after.length
    hunks++
  }
  if (!hunks) throw new ToolError('Update contains no hunks')
  return lines.join(eol) + (trailing && lines.length ? eol : '')
}

type Change = { target: string; name: string; before: string | null; after: string | null }

async function prepareChanges(patch: string, root: string): Promise<Change[]> {
  const changes: Change[] = []
  const seen = new Set<string>()
  for (const operation of parse(patch)) {
    const target = resolveInWorkspace(root, operation.path)
    if (seen.has(target)) throw new ToolError('Each file may appear only once in a patch')
    seen.add(target)
    const before = await readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    let after: string | null
    if (operation.kind === 'Add') {
      if (before !== null) throw new ToolError(`File already exists: ${operation.path}`)
      if (operation.lines.some((line) => !line.startsWith('+'))) throw new ToolError('Added file lines must start with +')
      after = operation.lines.length ? operation.lines.map((line) => line.slice(1)).join('\n') + '\n' : ''
    } else {
      if (before === null) throw new ToolError(`File not found: ${operation.path}`)
      if (operation.kind === 'Delete' && operation.lines.length) throw new ToolError('Delete File takes no hunk lines')
      after = operation.kind === 'Delete' ? null : update(before, operation.lines)
    }
    changes.push({ target, name: operation.path, before, after })
  }
  return changes
}

function diffOf(changes: Change[]): string {
  return changes.map((change) => unifiedDiff(change.name, change.before ?? '', change.after ?? '', TRANSCRIPT_DIFF_CHARS)).join('\n')
}

export const applyPatchTool = defineTool({
  name: 'apply_patch',
  description: 'Create, update, or delete workspace files with a patch. Format: *** Begin Patch, *** Add File: path (all lines prefixed +), *** Update File: path (@@ then space/context, -old, +new), *** Delete File: path, *** End Patch. Context must match exactly once. No moves. Read existing files first.',
  readOnly: false,
  risk: (input) => parse(input.patch).some((operation) => operation.kind === 'Delete') ? 'high' : 'medium',
  schema: z.object({ patch: z.string().min(1) }),
  preview: async (input, context) => ({
    kind: 'diff', subject: 'Workspace patch', detail: diffOf(await prepareChanges(input.patch, context.workspaceRoot))
  }),
  execute: async (input, context) => {
    // Validate every file/hunk before mutating any file.
    const changes = await prepareChanges(input.patch, context.workspaceRoot)
    const applied: Change[] = []
    try {
      for (const change of changes) {
        context.signal.throwIfAborted()
        resolveInWorkspace(context.workspaceRoot, change.name)
        if (change.after === null) {
          await unlink(change.target)
          applied.push(change)
        } else {
          await mkdir(path.dirname(change.target), { recursive: true })
          // Track existing files before writing, so a partial write can be restored.
          if (change.before !== null) applied.push(change)
          // Exclusive create refuses a file that appeared after validation.
          await writeFile(change.target, change.after, { encoding: 'utf8', flag: change.before === null ? 'wx' : 'w' })
          if (change.before === null) applied.push(change)
        }
      }
    } catch (error) {
      const failed: string[] = []
      for (const change of applied.reverse()) {
        try {
          if (change.before === null) await unlink(change.target)
          else await writeFile(change.target, change.before, 'utf8')
        } catch { failed.push(change.name) }
      }
      throw new ToolError(`Patch failed: ${(error as Error).message}${failed.length ? `. Could not restore: ${failed.join(', ')}` : '. Earlier changes restored.'}`)
    }
    return { text: `Applied patch: ${changes.map((change) => change.name).join(', ')}`, images: [], diff: diffOf(changes) }
  }
})
