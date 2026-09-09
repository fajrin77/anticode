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
    throw new ToolError(`Failed to open workbook: ${(error as Error).message}`)
  }
  return workbook
}

function pickSheet(workbook: ExcelJS.Workbook, name?: string): ExcelJS.Worksheet {
  const sheet = name !== undefined ? workbook.getWorksheet(name) : workbook.worksheets[0]
  if (!sheet) {
    const available = workbook.worksheets.map((s) => s.name).join(', ')
    throw new ToolError(`Sheet ${name ?? '(first)'} does not exist. Available: ${available}`)
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
  if (sheet.rowCount > MAX_ROWS) notes.push(`${sheet.rowCount - MAX_ROWS} more rows not shown`)
  if (sheet.columnCount > MAX_COLUMNS) {
    notes.push(`${sheet.columnCount - MAX_COLUMNS} more columns not shown`)
  }

  const body = lines.length > 0 ? lines.join('\n') : '(empty sheet)'
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
    'Read an Excel (.xlsx) file as a table with numbered rows. Without a sheet, the first ' +
    'one is read. Formulas are shown as-is with a leading "=".',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('Xlsx file path relative to the workspace root'),
    sheet: z.string().optional().describe('Sheet name; defaults to the first one')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const workbook = await open(target)
    const sheet = pickSheet(workbook, input.sheet)
    const names = workbook.worksheets.map((s) => s.name).join(', ')
    return `Active sheet: ${sheet.name} (available: ${names})\n\n${renderSheet(sheet)}`
  }
})

export const writeExcelCellTool = defineTool({
  name: 'write_excel_cell',
  description:
    'Change the value of one cell in an Excel file, e.g. cell "B4". Numbers and text are told apart automatically.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Xlsx file path relative to the workspace root'),
    sheet: z.string().optional().describe('Sheet name; defaults to the first one'),
    cell: z.string().regex(/^[A-Za-z]+\d+$/).describe('Cell address, e.g. B4'),
    value: z.string().describe('New value; plain numbers are stored as numbers')
  }),
  preview: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const sheet = pickSheet(await open(target), input.sheet)
    const before = cellText(sheet.getCell(input.cell).value)
    return {
      kind: 'text',
      subject: `${input.path} · ${sheet.name}!${input.cell}`,
      detail: `before: ${before === '' ? '(empty)' : before}\nafter: ${input.value}`
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
    'Set a formula in one cell, e.g. "SUM(B2:B10)". Write it without a leading equals sign.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Xlsx file path relative to the workspace root'),
    sheet: z.string().optional().describe('Sheet name; defaults to the first one'),
    cell: z.string().regex(/^[A-Za-z]+\d+$/).describe('Alamat cell, misalnya B12'),
    formula: z.string().min(1).describe('Formula without a leading "=", e.g. SUM(B2:B10)')
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
    return `${sheet.name}!${input.cell} = ${formula} (the result is computed when the file opens in Excel)`
  }
})
