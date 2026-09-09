import { rm, stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description:
    'Delete a file inside the workspace. Use recursive only when a folder and everything ' +
    'inside it really must go.',
  readOnly: false,
  risk: 'high',
  schema: z.object({
    path: z.string().describe('File or folder path, relative to the workspace root'),
    recursive: z
      .boolean()
      .default(false)
      .describe('Required true to delete a folder and everything inside it')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const info = await stat(target).catch(() => null)
    const kind = info === null ? 'not found' : info.isDirectory() ? 'folder' : 'file'
    const size = info?.isFile() === true ? `\nsize: ${info.size} bytes` : ''
    return {
      kind: 'text',
      subject: input.path,
      detail: `Deleting ${kind}: ${input.path}${size}\nrecursive: ${input.recursive}`
    }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    const info = await stat(target).catch(() => null)
    if (info === null) throw new ToolError(`Not found: ${input.path}`)
    if (info.isDirectory() && !input.recursive) {
      throw new ToolError(`${input.path} is a folder; set recursive true if it really should be deleted`)
    }

    try {
      await rm(target, { recursive: input.recursive, force: false })
    } catch (error) {
      throw new ToolError(`Failed to delete ${input.path}: ${(error as Error).message}`)
    }
    return `Deleted: ${input.path}`
  }
})
