import { rm, stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description:
    'Hapus berkas di dalam workspace. Gunakan recursive hanya bila memang perlu menghapus folder ' +
    'beserta isinya.',
  readOnly: false,
  risk: 'high',
  schema: z.object({
    path: z.string().describe('Path berkas atau folder, relatif terhadap root workspace'),
    recursive: z
      .boolean()
      .default(false)
      .describe('Wajib true untuk menghapus folder beserta isinya')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const info = await stat(target).catch(() => null)
    const kind = info === null ? 'tidak ditemukan' : info.isDirectory() ? 'folder' : 'berkas'
    const size = info?.isFile() === true ? `\nukuran: ${info.size} byte` : ''
    return {
      kind: 'text',
      subject: input.path,
      detail: `Menghapus ${kind}: ${input.path}${size}\nrecursive: ${input.recursive}`
    }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    const info = await stat(target).catch(() => null)
    if (info === null) throw new ToolError(`Tidak ditemukan: ${input.path}`)
    if (info.isDirectory() && !input.recursive) {
      throw new ToolError(`${input.path} adalah folder; set recursive true bila memang ingin dihapus`)
    }

    try {
      await rm(target, { recursive: input.recursive, force: false })
    } catch (error) {
      throw new ToolError(`Gagal menghapus ${input.path}: ${(error as Error).message}`)
    }
    return `Terhapus: ${input.path}`
  }
})
