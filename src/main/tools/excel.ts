import ExcelJS from 'exceljs'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_ROWS = 200
const MAX_COLUMNS = 40

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const record = value as unknown as Record<string, unknown>
    if ('formula' in record) return `=${String(record['formula'])}`
    if ('result' in record) return String(record['result'])
    if ('text' in record) return String(record['text'])
    if ('richText' in record) {
      return (record['richText'] as { text: string }[]).map((part) => part.text).join('')
    }
    return JSON.stringify(value)
  }
  return String(value)
}

async function open(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.readFile(filePath)
  } catch (error) {
    throw new ToolError(`Gagal membuka workbook: ${(error as Error).message}`)
  }
  return workbook
}

function pickSheet(workbook: ExcelJS.Workbook, name?: string): ExcelJS.Worksheet {
  const sheet = name !== undefined ? workbook.getWorksheet(name) : workbook.worksheets[0]
  if (!sheet) {
    const available = workbook.worksheets.map((s) => s.name).join(', ')
    throw new ToolError(`Sheet ${name ?? '(pertama)'} tidak ada. Tersedia: ${available}`)
  }
  return sheet
}

function renderSheet(sheet: ExcelJS.Worksheet): string {
  const rowCount = Math.min(sheet.rowCount, MAX_ROWS)
  const columnCount = Math.min(sheet.columnCount, MAX_COLUMNS)
  const lines: string[] = []

  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r)
    const cells: string[] = []
    for (let c = 1; c <= columnCount; c++) cells.push(cellText(row.getCell(c).value))
    if (cells.some((cell) => cell !== '')) lines.push(`${r}\t${cells.join('\t')}`)
  }

  const notes: string[] = []
  if (sheet.rowCount > MAX_ROWS) notes.push(`${sheet.rowCount - MAX_ROWS} baris lain tidak ditampilkan`)
  if (sheet.columnCount > MAX_COLUMNS) {
    notes.push(`${sheet.columnCount - MAX_COLUMNS} kolom lain tidak ditampilkan`)
  }

  const body = lines.length > 0 ? lines.join('\n') : '(sheet kosong)'
  return notes.length > 0 ? `${body}\n… ${notes.join('; ')}` : body
}

/** Used by the attachment handler to preview a workbook without a tool call. */
export async function summariseExcel(filePath: string): Promise<string> {
  const workbook = await open(filePath)
  const header = workbook.worksheets
    .map((sheet) => `- ${sheet.name} (${sheet.rowCount} baris × ${sheet.columnCount} kolom)`)
    .join('\n')
  const first = workbook.worksheets[0]
  return first
    ? `Sheet:\n${header}\n\nIsi ${first.name}:\n${renderSheet(first)}`
    : `Sheet:\n${header}`
}

export const readExcelTool = defineTool({
  name: 'read_excel',
  description:
    'Baca isi berkas Excel (.xlsx) sebagai tabel bernomor baris. Tanpa sheet, sheet pertama yang ' +
    'dibaca. Formula ditampilkan apa adanya dengan awalan "=".',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('Path berkas .xlsx relatif terhadap root workspace'),
    sheet: z.string().optional().describe('Nama sheet; default sheet pertama')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const workbook = await open(target)
    const sheet = pickSheet(workbook, input.sheet)
    const names = workbook.worksheets.map((s) => s.name).join(', ')
    return `Sheet aktif: ${sheet.name} (tersedia: ${names})\n\n${renderSheet(sheet)}`
  }
})

export const writeExcelCellTool = defineTool({
  name: 'write_excel_cell',
  description:
    'Ubah nilai satu cell di berkas Excel, misalnya cell "B4". Angka dan teks dibedakan otomatis.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Path berkas .xlsx relatif terhadap root workspace'),
    sheet: z.string().optional().describe('Nama sheet; default sheet pertama'),
    cell: z.string().regex(/^[A-Za-z]+\d+$/).describe('Alamat cell, misalnya B4'),
    value: z.string().describe('Nilai baru; angka murni disimpan sebagai angka')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const sheet = pickSheet(await open(target), input.sheet)
    const before = cellText(sheet.getCell(input.cell).value)
    return {
      kind: 'text',
      subject: `${input.path} · ${sheet.name}!${input.cell}`,
      detail: `sebelum: ${before === '' ? '(kosong)' : before}\nsesudah: ${input.value}`
    }
  },
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const workbook = await open(target)
    const sheet = pickSheet(workbook, input.sheet)

    const numeric = Number(input.value)
    const before = cellText(sheet.getCell(input.cell).value)
    sheet.getCell(input.cell).value =
      input.value.trim() !== '' && !Number.isNaN(numeric) ? numeric : input.value

    await workbook.xlsx.writeFile(target)
    return `${sheet.name}!${input.cell}: "${before}" → "${input.value}"`
  }
})

export const addExcelFormulaTool = defineTool({
  name: 'add_excel_formula',
  description:
    'Pasang formula di satu cell, misalnya "SUM(B2:B10)". Tulis tanpa tanda sama dengan di depan.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Path berkas .xlsx relatif terhadap root workspace'),
    sheet: z.string().optional().describe('Nama sheet; default sheet pertama'),
    cell: z.string().regex(/^[A-Za-z]+\d+$/).describe('Alamat cell, misalnya B12'),
    formula: z.string().min(1).describe('Formula tanpa "=" di depan, misalnya SUM(B2:B10)')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: `${input.path} · ${input.cell}`,
    detail: `=${input.formula.replace(/^=/, '')}`
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const workbook = await open(target)
    const sheet = pickSheet(workbook, input.sheet)
    const formula = input.formula.replace(/^=/, '')

    sheet.getCell(input.cell).value = { formula, date1904: false }
    await workbook.xlsx.writeFile(target)
    // Excel recalculates on open; exceljs stores no cached result.
    return `${sheet.name}!${input.cell} = ${formula} (hasil dihitung saat berkas dibuka di Excel)`
  }
})
