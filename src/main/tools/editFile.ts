import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { unifiedDiff } from './diff'

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace one piece of text inside a file. old_string must appear exactly once; ' +
    'include surrounding context when the snippet is not unique.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    old_string: z.string().min(1).describe('Text to replace, must be unique in the file'),
    new_string: z.string().describe('Replacement text')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    if (original === null) {
      return { kind: 'text', subject: input.path, detail: 'File not found.' }
    }
    // Mirror execute(): an ambiguous or absent target never produces a diff,
    // so the reviewer never approves a change that would be refused.
    const occurrences = original.split(input.old_string).length - 1
    if (occurrences === 0) {
      return { kind: 'text', subject: input.path, detail: 'old_string not found in this file.' }
    }
    if (occurrences > 1) {
      return {
        kind: 'text',
        subject: input.path,
        detail: `old_string appears ${occurrences} times — expand the context to make it unique. Nothing was changed.`
      }
    }
    return {
      kind: 'diff',
      subject: input.path,
      detail: unifiedDiff(input.path, original, original.replace(input.old_string, input.new_string))
    }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    let original: string
    try {
      original = await readFile(target, 'utf8')
    } catch (error) {
      throw new ToolError(`Failed to read ${input.path}: ${(error as Error).message}`)
    }

    if (input.old_string === input.new_string) {
      throw new ToolError('old_string and new_string are identical — nothing to change')
    }

    const occurrences = original.split(input.old_string).length - 1
    if (occurrences === 0) {
      throw new ToolError(`old_string not found in ${input.path}`)
    }
    if (occurrences > 1) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${input.path}; expand the context to make it unique`
      )
    }

    const updated = original.replace(input.old_string, input.new_string)
    try {
      await writeFile(target, updated, 'utf8')
    } catch (error) {
      throw new ToolError(`Failed to write ${input.path}: ${(error as Error).message}`)
    }

    const before = original.split('\n').length
    const after = updated.split('\n').length
    return `Edited: ${input.path} (${before} → ${after} lines)`
  }
})
