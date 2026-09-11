import { mkdir, readFile, writeFile as write } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { TRANSCRIPT_DIFF_CHARS, unifiedDiff } from './diff'
import { diffStat } from './editFile'

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Write a text file inside the workspace, overwriting it if it already exists. ' +
    'To change part of an existing file, use edit_file.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    content: z.string().describe('Full contents of the file')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    return original === null
      ? { kind: 'text', subject: input.path, detail: `New file:\n\n${input.content}` }
      : { kind: 'diff', subject: input.path, detail: unifiedDiff(input.path, original, input.content) }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await write(target, input.content, 'utf8')
    } catch (error) {
      throw new ToolError(`Failed to write ${input.path}: ${(error as Error).message}`)
    }
    const stat =
      original === null ? `(+${input.content === '' ? 0 : input.content.split('\n').length})` : diffStat(original, input.content)
    return {
      text: `Saved: ${input.path} ${stat}`,
      images: [],
      diff: unifiedDiff(input.path, original ?? '', input.content, TRANSCRIPT_DIFF_CHARS)
    }
  }
})
