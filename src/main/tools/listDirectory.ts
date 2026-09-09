import { readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_ENTRIES = 500

export const listDirectoryTool = defineTool({
  name: 'list_directory',
  description: 'Daftar isi sebuah folder di dalam workspace. Folder ditandai dengan akhiran "/".',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z
      .string()
      .default('.')
      .describe('Path folder relatif terhadap root workspace; default root itu sendiri')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    let entries: Dirent[]
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (error) {
      throw new ToolError(`Gagal membaca folder ${input.path}: ${(error as Error).message}`)
    }

    if (entries.length === 0) return '(folder kosong)'

    const listed = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))

    const shown = listed.slice(0, MAX_ENTRIES).join('\n')
    return listed.length > MAX_ENTRIES
      ? `${shown}\n… ${listed.length - MAX_ENTRIES} entri lain tidak ditampilkan`
      : shown
  }
})
