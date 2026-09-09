import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isIgnoredEntry } from './ignore'

const MAX_ENTRIES = 500

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description:
    'List the contents of a folder inside the workspace. Directories get a trailing "/". ' +
    'Dependency and cache folders like node_modules are not shown.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z
      .string()
      .default('.')
      .describe('Folder path relative to the workspace root; defaults to the root itself')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    let entries: Dirent[]
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (error) {
      throw new ToolError(`Failed to read folder ${input.path}: ${(error as Error).message}`)
    }

    const visible = entries.filter((entry) => !isIgnoredEntry(entry.name, entry.isDirectory()))
    if (visible.length === 0) {
      return entries.length > 0 ? '(all entries ignored)' : '(empty folder)'
    }

    const listed = visible
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))

    const shown = listed.slice(0, MAX_ENTRIES).join('\n')
    const notes: string[] = []
    if (listed.length > MAX_ENTRIES) {
      notes.push(`${listed.length - MAX_ENTRIES} more entries not shown`)
    }
    const ignored = entries.length - visible.length
    if (ignored > 0) notes.push(`${ignored} entries (dependencies/cache) ignored`)

    return notes.length > 0 ? `${shown}\n… ${notes.join('; ')}` : shown
  }
})
