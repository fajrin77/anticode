import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The only way a file the agent did not write with a document tool, a build
 * output, something a command produced, a copy, reaches the user as a file
 * card. The transcript draws the card from this call itself, so the agent
 * cannot say a file is there without it actually being there.
 */
export const shareFileTool = defineTool({
  name: 'share_file',
  description:
    'Show an existing file to the user as a file card in the conversation, with Preview and Download, ' +
    'on the desktop and the phone. Use it whenever the user wants to get, open, or download a file ' +
    'that you did not write with an Excel/Word/PDF tool, for example a build output or a file made ' +
    'by a command. The file stays where it is; nothing is copied.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().min(1).describe('File path relative to the workspace root')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const info = await stat(target).catch(() => null)
    if (info === null) throw new ToolError(`File not found: ${input.path}`)
    if (!info.isFile()) throw new ToolError(`${input.path} is a folder, not a file`)
    return `${input.path} (${formatSize(info.size)}) is now shown to the user as a file card with Preview and Download.`
  }
})
