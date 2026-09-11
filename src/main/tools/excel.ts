import path from 'node:path'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_ROWS = 200
const MAX_COLUMNS = 40
/** Formatting lines shown per sheet; past this the summary is noise. */
const MAX_STYLE_LINES = 40
/** One call may restyle a whole table, not a whole million-row sheet. */
const MAX_FORMAT_CELLS = 100_000

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

/**
 * A workbook the tools may load whole. ExcelJS and SheetJS both hold every
 * cell as an object, so a 75 MB sheet can want gigabytes of RAM — enough to
 * take the whole app down. Past this bound the file is refused with a clear
 * message instead: the app survives, the user splits the file.
 */
const MAX_WORKBOOK_BYTES = 30 * 1024 * 1024

function workbookTooLarge(size: number): ToolError {
  return new ToolError(
    `Workbook too large to open whole (${Math.round(size / 1024 / 1024)} MB, limit ` +
      `${MAX_WORKBOOK_BYTES / 1024 / 1024} MB). Split it into smaller files, or delete the ` +
      'sheets and rows you do not need, then try again.'
  )
}

function checkedSize(filePath: string): number {
  const size = statSync(filePath).size
  if (size > MAX_WORKBOOK_BYTES) throw workbookTooLarge(size)
  return size
}

/**
 * Legacy 97-2003 workbooks are converted in memory so merely attaching or
 * reading one never writes beside the user's original. SheetJS only bridges
 * the old bytes; exceljs keeps owning edits and explicit .xlsx output. Dense
 * mode keeps cells as arrays, several times lighter on a big workbook.
 */
async function convertLegacy(filePath: string): Promise<ArrayBuffer> {
  // The ESM build of SheetJS does not bind Node's filesystem helpers, so its
  // readFile/writeFile shortcuts fail inside Electron. Bytes keep this path
  // identical in tests and the packaged app.
  const book = XLSX.read(await readFile(filePath), { type: 'buffer', dense: true })
  const data = XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }) as Uint8Array
  if (data.byteLength > MAX_WORKBOOK_BYTES) throw workbookTooLarge(data.byteLength)
  // Copy into a plain ArrayBuffer: ExcelJS's public load signature does not
  // accept Node's wider ArrayBufferLike backing type.
  return Uint8Array.from(data).buffer
}

/** Shared with the in-app viewer, so a legacy .xls opens there the same way. */
export async function open(filePath: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook()
  checkedSize(filePath)
  if (path.extname(filePath).toLowerCase() === '.xls') {
    try {
      await workbook.xlsx.load(await convertLegacy(filePath))
      return workbook
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Failed to read legacy .xls file: ${(error as Error).message}`)
    }
  }
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

export function columnName(index: number): string {
  let name = ''
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name
  }
  return name
}

function colourOf(colour: Partial<ExcelJS.Color> | undefined): string | null {
  if (colour === undefined) return null
  if (typeof colour.argb === 'string') return `#${colour.argb.slice(-6).toUpperCase()}`
  if (typeof colour.theme === 'number') return `theme ${colour.theme}`
  return null
}

/**
 * The formatting a person would notice: background, text colour, weight.
 * Black text — as argb or as the default theme text colour — is left out, or
 * every cell of every sheet would carry it.
 */
function styleOf(cell: ExcelJS.Cell): string {
  const parts: string[] = []
  const fill = cell.fill
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const colour = colourOf(fill.fgColor)
    if (colour !== null) parts.push(`fill ${colour}`)
  }
  const font = cell.font as Partial<ExcelJS.Font> | undefined
  const text = colourOf(font?.color)
  if (text !== null && text !== '#000000' && text !== 'theme 1') parts.push(`font ${text}`)
  if (font?.bold === true) parts.push('bold')
  if (font?.italic === true) parts.push('italic')
  return parts.join(', ')
}

/**
 * Formatting as ranges rather than cells: runs of alike cells within a row,
 * then identical rows folded together — so a blue header reads as one line,
 * which is what a request like "make the blue header red" needs to see.
 */
function describeStyles(sheet: ExcelJS.Worksheet, rowCount: number, columnCount: number): string[] {
  interface Run { from: number; to: number; style: string }
  const blocks: { first: number; last: number; key: string; runs: Run[] }[] = []
  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r)
    const runs: Run[] = []
    for (let c = 1; c <= columnCount; c++) {
      const style = styleOf(row.getCell(c))
      if (style === '') continue
      const previous = runs.at(-1)
      if (previous !== undefined && previous.to === c - 1 && previous.style === style) previous.to = c
      else runs.push({ from: c, to: c, style })
    }
    if (runs.length === 0) continue
    const key = JSON.stringify(runs)
    const block = blocks.at(-1)
    if (block !== undefined && block.last === r - 1 && block.key === key) block.last = r
    else blocks.push({ first: r, last: r, key, runs })
  }

  const lines = blocks.flatMap((block) =>
    block.runs.map((run) => {
      const start = `${columnName(run.from)}${block.first}`
      const end = `${columnName(run.to)}${block.last}`
      return `- ${start === end ? start : `${start}:${end}`} ${run.style}`
    })
  )
  return lines.length > MAX_STYLE_LINES
    ? [...lines.slice(0, MAX_STYLE_LINES), `… ${lines.length - MAX_STYLE_LINES} more formatted ranges`]
    : lines
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
  const table = notes.length > 0 ? `${body}\n… ${notes.join('; ')}` : body
  // Ahead of the rows, so a clipped attachment preview still carries it.
  const styles = describeStyles(sheet, rowCount, columnCount)
  return styles.length > 0 ? `Formatting (fill is the background colour):\n${styles.join('\n')}\n\n${table}` : table
}

/** Used by the attachment handler to preview a workbook without a tool call. */
export async function summariseExcel(filePath: string): Promise<string> {
  checkedSize(filePath)
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
    'Read an Excel (.xlsx or legacy .xls) file as a table with numbered rows. Without a sheet, the first ' +
    'one is read. Formulas are shown as-is with a leading "=". Fill colours, text colours, ' +
    'and bold are listed per range above the rows.',
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

export const createExcelTool = defineTool({
  name: 'create_excel',
  description:
    'Create a new Excel (.xlsx) file from a table of rows. The first row is treated as the ' +
    'header. Values that look like numbers are stored as numbers, and cells starting with ' +
    '"=" are stored as formulas.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Destination .xlsx path, relative to the workspace root'),
    sheet: z.string().default('Sheet1').describe('Name of the sheet to create'),
    rows: z
      .array(z.array(z.string()))
      .min(1)
      .describe('Rows of cell values; the first row is the header')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: input.path,
    detail: input.rows
      .slice(0, 10)
      .map((row) => row.join('\t'))
      .join('\n')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet(input.sheet)

    for (const row of input.rows) {
      sheet.addRow(
        row.map((value) => {
          if (value.startsWith('=')) return { formula: value.slice(1), date1904: false }
          const numeric = Number(value)
          return value.trim() !== '' && !Number.isNaN(numeric) ? numeric : value
        })
      )
    }

    // A header nobody can read is a table nobody can use: bold it and widen
    // every column to its longest value.
    sheet.getRow(1).font = { bold: true }
    const widths = input.rows.reduce<number[]>((longest, row) => {
      row.forEach((value, index) => {
        longest[index] = Math.max(longest[index] ?? 10, Math.min(60, value.length + 2))
      })
      return longest
    }, [])
    widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width })

    try {
      await workbook.xlsx.writeFile(target)
    } catch (error) {
      throw new ToolError(`Failed to write workbook: ${(error as Error).message}`)
    }
    return `Saved: ${input.path} (${input.rows.length} rows × ${widths.length} columns)`
  }
})

const CELL = /^([A-Za-z]+)(\d+)$/
const RANGE_LIST = /^\s*[A-Za-z]+\d+(:[A-Za-z]+\d+)?(\s*,\s*[A-Za-z]+\d+(:[A-Za-z]+\d+)?)*\s*$/
const HEX_COLOUR = /^#?[0-9A-Fa-f]{6}$/

interface Area { top: number; left: number; bottom: number; right: number; label: string }

function decodeCell(address: string): { row: number; column: number } {
  const match = CELL.exec(address.trim())
  if (match === null) throw new ToolError(`Not a cell address: ${address}`)
  const column = [...(match[1] ?? '').toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0)
  return { row: Number(match[2]), column }
}

function decodeRanges(list: string): Area[] {
  return list.split(',').map((part) => {
    const [first = '', second = first] = part.trim().split(':')
    const a = decodeCell(first)
    const b = decodeCell(second)
    return {
      top: Math.min(a.row, b.row),
      bottom: Math.max(a.row, b.row),
      left: Math.min(a.column, b.column),
      right: Math.max(a.column, b.column),
      label: part.trim().toUpperCase()
    }
  })
}

function* cellsOf(sheet: ExcelJS.Worksheet, areas: Area[]): Generator<ExcelJS.Cell> {
  for (const area of areas) {
    for (let r = area.top; r <= area.bottom; r++) {
      for (let c = area.left; c <= area.right; c++) yield sheet.getCell(r, c)
    }
  }
}

function argbOf(hex: string): string {
  return `FF${hex.replace(/^#/, '').toUpperCase()}`
}

const formatSchema = z
  .object({
    path: z.string().describe('Xlsx file path relative to the workspace root'),
    sheet: z.string().optional().describe('Sheet name; defaults to the first one'),
    range: z
      .string()
      .regex(RANGE_LIST)
      .describe('One or more ranges separated by commas, e.g. "A1:G1,I1:K1" or "B4"'),
    fill: z
      .string()
      .regex(/^(#?[0-9A-Fa-f]{6}|none)$/)
      .optional()
      .describe('Background colour as hex, e.g. "#FF0000"; "none" removes the background'),
    font_color: z.string().regex(HEX_COLOUR).optional().describe('Text colour as hex, e.g. "#FFFFFF"'),
    bold: z.boolean().optional().describe('Make the text bold (true) or regular (false)'),
    output_path: z
      .string()
      .optional()
      .describe('Save the result to this .xlsx path instead of overwriting the original')
  })
  .refine((input) => input.fill !== undefined || input.font_color !== undefined || input.bold !== undefined, {
    message: 'Give at least one of fill, font_color, or bold'
  })

type FormatInput = z.output<typeof formatSchema>

function describeChange(input: FormatInput): string {
  const parts: string[] = []
  if (input.fill !== undefined) parts.push(input.fill === 'none' ? 'no fill' : `fill #${input.fill.replace(/^#/, '').toUpperCase()}`)
  if (input.font_color !== undefined) parts.push(`font #${input.font_color.replace(/^#/, '').toUpperCase()}`)
  if (input.bold !== undefined) parts.push(input.bold ? 'bold' : 'not bold')
  return parts.join(', ')
}

function formatTarget(input: FormatInput): string {
  const destination = input.output_path ?? input.path
  if (!/\.xlsx$/i.test(destination)) {
    throw new ToolError(`Formatted workbooks are saved as .xlsx; ${destination} is not one`)
  }
  return destination
}

export const formatExcelCellsTool = defineTool({
  name: 'format_excel_cells',
  description:
    'Change how cells look in an Excel (.xlsx) file: background fill colour, text colour, ' +
    'and bold. Values, other formatting, and the rest of the workbook are kept. read_excel ' +
    'lists the current fills per range, so "make the blue header red" means reading first, ' +
    'then formatting exactly the ranges that are blue.',
  readOnly: false,
  risk: 'medium',
  schema: formatSchema,
  preview: async (input, context) => {
    const sheet = pickSheet(await open(resolveInWorkspace(context.workspaceRoot, input.path)), input.sheet)
    const before = new Set<string>()
    for (const cell of cellsOf(sheet, decodeRanges(input.range))) {
      before.add(styleOf(cell) || '(no formatting)')
      if (before.size > 5) break
    }
    const destination = formatTarget(input)
    return {
      kind: 'text',
      subject: `${destination} · ${sheet.name}!${input.range.replace(/\s+/g, '')}`,
      detail: `before: ${[...before].join(' | ')}\nafter: ${describeChange(input)}`
    }
  },
  execute: async (input, context) => {
    const destination = formatTarget(input)
    const target = resolveInWorkspace(context.workspaceRoot, destination)
    const workbook = await open(resolveInWorkspace(context.workspaceRoot, input.path))
    const sheet = pickSheet(workbook, input.sheet)
    const areas = decodeRanges(input.range)
    const count = areas.reduce((sum, area) => sum + (area.bottom - area.top + 1) * (area.right - area.left + 1), 0)
    if (count > MAX_FORMAT_CELLS) {
      throw new ToolError(`${count} cells is more than one call may format (${MAX_FORMAT_CELLS})`)
    }

    for (const cell of cellsOf(sheet, areas)) {
      // A whole new style object per cell. exceljs hands cells that were
      // loaded alike one shared style, and `cell.fill = …` writes into it —
      // which would repaint every other cell that happened to look the same.
      const style: Partial<ExcelJS.Style> = { ...cell.style }
      if (input.fill === 'none') style.fill = { type: 'pattern', pattern: 'none' }
      else if (input.fill !== undefined) {
        style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argbOf(input.fill) } }
      }
      if (input.font_color !== undefined || input.bold !== undefined) {
        style.font = {
          ...cell.font,
          ...(input.font_color !== undefined ? { color: { argb: argbOf(input.font_color) } } : {}),
          ...(input.bold !== undefined ? { bold: input.bold } : {})
        }
      }
      cell.style = style
    }

    try {
      await workbook.xlsx.writeFile(target)
    } catch (error) {
      throw new ToolError(`Failed to write workbook: ${(error as Error).message}`)
    }
    return `${sheet.name}!${areas.map((area) => area.label).join(',')}: ${count} cells → ${describeChange(input)}. Saved: ${destination}`
  }
})
