import { readFile, writeFile } from 'node:fs/promises'
import { diffLines } from 'diff'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { TRANSCRIPT_DIFF_CHARS, unifiedDiff } from './diff'

function countLines(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

/** A compact "+added -removed" tail the UI parses into run summaries. */
export function diffStat(before: string, after: string): string {
  if (before === after) return '(no line changes)'
  const changes = diffLines(before, after, { maxEditLength: 2_500 })
  let added = 0
  let removed = 0
  if (changes !== undefined) {
    for (const part of changes) {
      const lines = part.count ?? countLines(part.value)
      if (part.added) added += lines
      else if (part.removed) removed += lines
    }
  } else {
    // Huge wholesale rewrites exceed Myers edit cap; trim common prefix/suffix lines in O(N).
    const a = before === '' ? [] : before.split('\n')
    const b = after === '' ? [] : after.split('\n')
    let start = 0
    const minLen = Math.min(a.length, b.length)
    while (start < minLen && a[start] === b[start]) start++
    let endA = a.length - 1
    let endB = b.length - 1
    while (endA >= start && endB >= start && a[endA] === b[endB]) {
      endA--
      endB--
    }
    removed = Math.max(0, endA - start + 1)
    added = Math.max(0, endB - start + 1)
  }
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (removed > 0) parts.push(`-${removed}`)
  return parts.length > 0 ? `(${parts.join(' ')})` : '(no line changes)'
}

function matchAndReplace(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): { count: number; updated: string } {
  let needle = oldString
  let replacement = newString
  let count = original.split(needle).length - 1
  if (count === 0 && original.includes('\r\n') && !oldString.includes('\r\n') && oldString.includes('\n')) {
    needle = oldString.replace(/\n/g, '\r\n')
    replacement = newString.replace(/\r?\n/g, '\r\n')
    count = original.split(needle).length - 1
  }
  if (count === 0 || (!replaceAll && count > 1)) return { count, updated: original }
  const updated = replaceAll
    ? original.split(needle).join(replacement)
    : original.replace(needle, () => replacement)
  return { count, updated }
}

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replace text inside a file. By default old_string must appear exactly once; ' +
    'include surrounding context when not unique, or set replace_all true to replace every occurrence.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    old_string: z.string().min(1).describe('Text to replace'),
    new_string: z.string().describe('Replacement text'),
    replace_all: z.boolean().default(false).describe('True to replace every occurrence of old_string in the file')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    if (input.old_string === input.new_string) {
      return { kind: 'text', subject: input.path, detail: 'old_string and new_string are identical: nothing to change.' }
    }
    const original = await readFile(target, 'utf8').catch(() => null)
    if (original === null) {
      return { kind: 'text', subject: input.path, detail: 'File not found.' }
    }
    const { count, updated } = matchAndReplace(original, input.old_string, input.new_string, input.replace_all)
    if (count === 0) {
      return { kind: 'text', subject: input.path, detail: 'old_string not found in this file.' }
    }
    if (!input.replace_all && count > 1) {
      return {
        kind: 'text',
        subject: input.path,
        detail: `old_string appears ${count} times: expand the context to make it unique, or set replace_all true. Nothing was changed.`
      }
    }
    return {
      kind: 'diff',
      subject: input.path,
      detail: unifiedDiff(input.path, original, updated)
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
      throw new ToolError('old_string and new_string are identical: nothing to change')
    }

    const { count, updated } = matchAndReplace(original, input.old_string, input.new_string, input.replace_all)
    if (count === 0) {
      throw new ToolError(`old_string not found in ${input.path}`)
    }
    if (!input.replace_all && count > 1) {
      throw new ToolError(
        `old_string appears ${count} times in ${input.path}; expand the context to make it unique or set replace_all true`
      )
    }

    try {
      await writeFile(target, updated, 'utf8')
    } catch (error) {
      throw new ToolError(`Failed to write ${input.path}: ${(error as Error).message}`)
    }

    return {
      text: `Edited: ${input.path} ${diffStat(original, updated)}`,
      images: [],
      diff: unifiedDiff(input.path, original, updated, TRANSCRIPT_DIFF_CHARS)
    }
  }
})
