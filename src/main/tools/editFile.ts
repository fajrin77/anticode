import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'
import { unifiedDiff } from './diff'

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Ganti satu potongan teks di dalam berkas. old_string harus muncul tepat satu kali; ' +
    'sertakan konteks di sekitarnya bila potongan itu tidak unik.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Path berkas, relatif terhadap root workspace'),
    old_string: z.string().min(1).describe('Teks yang akan diganti, harus unik dalam berkas'),
    new_string: z.string().describe('Teks pengganti')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    if (original === null) {
      return { kind: 'text', subject: input.path, detail: 'Berkas tidak ditemukan.' }
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
      throw new ToolError(`Gagal membaca ${input.path}: ${(error as Error).message}`)
    }

    if (input.old_string === input.new_string) {
      throw new ToolError('old_string dan new_string identik, tidak ada yang perlu diubah')
    }

    const occurrences = original.split(input.old_string).length - 1
    if (occurrences === 0) {
      throw new ToolError(`old_string tidak ditemukan di ${input.path}`)
    }
    if (occurrences > 1) {
      throw new ToolError(
        `old_string muncul ${occurrences} kali di ${input.path}; perluas konteksnya agar unik`
      )
    }

    const updated = original.replace(input.old_string, input.new_string)
    try {
      await writeFile(target, updated, 'utf8')
    } catch (error) {
      throw new ToolError(`Gagal menulis ${input.path}: ${(error as Error).message}`)
    }

    const before = original.split('\n').length
    const after = updated.split('\n').length
    return `Terubah: ${input.path} (${before} → ${after} baris)`
  }
})
