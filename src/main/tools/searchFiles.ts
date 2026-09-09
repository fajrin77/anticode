import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { isIgnoredEntry } from './ignore'

const MAX_FILE_BYTES = 512 * 1024
const MAX_RESULTS = 100
const MAX_LINE_CHARS = 200
const MAX_DEPTH = 32

interface Hit {
  file: string
  line: number
  text: string
}

function isBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8 * 1024)
  return probe.includes(0)
}

function extensionMatches(fileName: string, glob: string | undefined): boolean {
  if (glob === undefined) return true
  const pattern = glob.startsWith('*.') ? glob.slice(1) : glob
  return fileName.toLowerCase().endsWith(pattern.toLowerCase())
}

async function* walk(
  dir: string,
  relative: string,
  depth: number
): AsyncGenerator<{ absolute: string; relative: string; entry: Dirent }> {
  if (depth > MAX_DEPTH) return

  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (isIgnoredEntry(entry.name, entry.isDirectory())) continue
    // Symlinks are skipped: they can escape the workspace or form cycles.
    if (entry.isSymbolicLink()) continue

    const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
    const absolute = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      yield* walk(absolute, childRelative, depth + 1)
    } else if (entry.isFile()) {
      yield { absolute, relative: childRelative, entry }
    }
  }
}

function compilePattern(input: { pattern: string; is_regex: boolean }): RegExp {
  const source = input.is_regex ? input.pattern : input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(source, 'i')
  } catch (error) {
    throw new ToolError(`Invalid pattern: ${(error as Error).message}`)
  }
}

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Search text across the whole workspace (case-insensitive) and return line matches ' +
    'with their line numbers. Far cheaper than guessing and reading files one by one. ' +
    'Folders like node_modules and .git are skipped.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    pattern: z.string().min(1).describe('Teks yang dicari'),
    path: z
      .string()
      .default('.')
      .describe('Folder to start the search from, relative to the workspace root'),
    glob: z
      .string()
      .optional()
      .describe('File name filter, e.g. "*.ts" — only files with that extension'),
    is_regex: z
      .boolean()
      .default(false)
      .describe('True when pattern is a regular expression, not plain text')
  }),
  execute: async (input, context) => {
    const base = resolveInWorkspace(context.workspaceRoot, input.path)
    const info = await stat(base).catch(() => null)
    if (info === null) throw new ToolError(`Folder not found: ${input.path}`)
    if (!info.isDirectory()) throw new ToolError(`${input.path} is not a folder`)

    const regex = compilePattern(input)
    const hits: Hit[] = []
    let scanned = 0

    for await (const file of walk(base, '', 0)) {
      if (hits.length >= MAX_RESULTS) break
      if (!extensionMatches(file.entry.name, input.glob)) continue

      let buffer: Buffer
      try {
        buffer = await readFile(file.absolute)
      } catch {
        continue
      }
      if (buffer.byteLength > MAX_FILE_BYTES || isBinary(buffer)) continue

      scanned += 1
      const lines = buffer.toString('utf8').split('\n')
      for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
        const line = lines[i] ?? ''
        if (!regex.test(line)) continue
        const clipped =
          line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line.trim()
        hits.push({ file: file.relative, line: i + 1, text: clipped })
      }
    }

    if (hits.length === 0) return `(no matches for "${input.pattern}")`

    const grouped = new Map<string, string[]>()
    for (const hit of hits) {
      const bucket = grouped.get(hit.file) ?? []
      bucket.push(`  ${String(hit.line).padStart(4)}\t${hit.text}`)
      grouped.set(hit.file, bucket)
    }

    const body = [...grouped.entries()]
      .map(([file, lines]) => `${file}\n${lines.join('\n')}`)
      .join('\n')
    const truncated = hits.length >= MAX_RESULTS ? `\n… results capped at ${MAX_RESULTS}` : ''
    return `${body}${truncated}`
  }
})
