import { readFile as read } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_LINE_LENGTH = 2000

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Baca isi berkas teks atau kode di dalam workspace. Keluaran diberi nomor baris. ' +
    'Gunakan offset dan limit untuk membaca sebagian berkas besar.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('Path berkas, relatif terhadap root workspace'),
    offset: z.number().int().min(1).optional().describe('Baris awal, dimulai dari 1'),
    limit: z.number().int().min(1).max(2000).optional().describe('Jumlah baris, maksimum 2000')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)

    let raw: string
    try {
      raw = await read(target, 'utf8')
    } catch (error) {
      throw new ToolError(`Gagal membaca ${input.path}: ${(error as Error).message}`)
    }

    if (raw.length === 0) return '(berkas kosong)'

    const lines = raw.split('\n')
    const start = (input.offset ?? 1) - 1
    if (start >= lines.length) {
      throw new ToolError(`Offset ${input.offset} melewati akhir berkas (${lines.length} baris)`)
    }

    const end = Math.min(lines.length, start + (input.limit ?? lines.length))
    const numbered = lines
      .slice(start, end)
      .map((line, index) => {
        const clipped =
          line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}… (dipotong)` : line
        return `${String(start + index + 1).padStart(5)}\t${clipped}`
      })
      .join('\n')

    const omitted = lines.length - end
    return omitted > 0 ? `${numbered}\n… ${omitted} baris berikutnya tidak ditampilkan` : numbered
  }
})
