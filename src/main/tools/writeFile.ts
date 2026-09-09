import { mkdir, readFile, writeFile as write } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { unifiedDiff } from './diff'

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Tulis berkas teks di dalam workspace, menimpa isi lama jika berkas sudah ada. ' +
    'Untuk mengubah sebagian isi berkas yang sudah ada, pakai edit_file.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Path berkas, relatif terhadap root workspace'),
    content: z.string().describe('Isi berkas secara utuh')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    return original === null
      ? { kind: 'text', subject: input.path, detail: `Berkas baru:\n\n${input.content}` }
      : { kind: 'diff', subject: input.path, detail: unifiedDiff(input.path, original, input.content) }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await write(target, input.content, 'utf8')
    } catch (error) {
      throw new ToolError(`Gagal menulis ${input.path}: ${(error as Error).message}`)
    }
    const lines = input.content === '' ? 0 : input.content.split('\n').length
    return `Tersimpan: ${input.path} (${lines} baris, ${Buffer.byteLength(input.content)} byte)`
  }
})
