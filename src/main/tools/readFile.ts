import { open, readFile as read, stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_LINE_LENGTH = 2000
/** Reads stay bounded by default so one call cannot flood the context. */
const DEFAULT_READ_LINES = 250
const MAX_READ_BYTES = 10 * 1024 * 1024

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Read a text or code file inside the workspace. Output is numbered by line. ' +
    'Reads the first 250 lines by default; use limit for more and offset to page through a large file.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    offset: z.number().int().min(1).optional().describe('First line, starting at 1'),
    limit: z.number().int().min(1).max(2000).optional().describe('Number of lines, max 2000')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    let raw: string
    try {
      const info = await stat(target)
      if (info.isDirectory()) throw new Error('EISDIR: path is a directory; use list_directory')
      if (info.size > MAX_READ_BYTES) {
        throw new Error(`file is too large (${Math.round(info.size / (1024 * 1024))} MB; max 10 MB for read_file)`)
      }
      if (info.size > 0) {
        const handle = await open(target, 'r')
        try {
          const sample = Buffer.alloc(Math.min(info.size, 8192))
          const { bytesRead } = await handle.read(sample, 0, sample.length, 0)
          if (sample.subarray(0, bytesRead).includes(0)) {
            throw new Error('binary file cannot be read as UTF-8 text')
          }
        } finally {
          await handle.close()
        }
      }
      raw = await read(target, 'utf8')
    } catch (error) {
      throw new ToolError(`Failed to read ${input.path}: ${(error as Error).message}`)
    }

    if (raw.length === 0) return '(empty file)'

    const lines = raw.split('\n')
    // A trailing newline is a line terminator, not an extra empty line.
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    const start = (input.offset ?? 1) - 1
    if (start >= lines.length) {
      throw new ToolError(`Offset ${input.offset} is past the end of the file (${lines.length} lines)`)
    }

    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_READ_LINES))
    const numbered = lines
      .slice(start, end)
      .map((line, index) => {
        const clipped =
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (clipped)` : line
        return `${String(start + index + 1).padStart(5)}\t${clipped}`
      })
      .join('\n')

    const omitted = lines.length - end
    return omitted > 0
      ? `${numbered}\n… ${omitted} more lines not shown, read again with offset ${end + 1} to continue`
      : numbered
  }
})
