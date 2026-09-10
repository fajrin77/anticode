import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import mammoth from 'mammoth'
import JSZip from 'jszip'
import type { FilePreview, PreviewPage } from '@shared/ipc'
import { columnName, open as openWorkbook } from './tools/excel'

/**
 * Files are looked at inside the app — the transcript's file cards and the
 * phone's alike — instead of being downloaded to be opened somewhere else.
 * Documents become self-contained HTML here, so both screens draw the same
 * page; pictures and PDFs are left to the viewer's own renderer.
 */

/** Past this a file is saved, not previewed. */
const MAX_BYTES = 40 * 1024 * 1024
const MAX_ROWS = 500
const MAX_COLUMNS = 60
const MAX_SHEETS = 30
const MAX_TEXT = 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
}

const WORKBOOKS = ['.xlsx', '.xlsm', '.xltx', '.xls']
const TABLES = ['.csv', '.tsv', '.ods']

export async function previewFile(target: string, withBytes: boolean): Promise<FilePreview> {
  const name = path.basename(target)
  const extension = path.extname(target).toLowerCase()
  const info = await stat(target).catch(() => null)
  if (info === null || !info.isFile()) return { kind: 'none', name, reason: 'This file is no longer there.' }
  if (info.size > MAX_BYTES) {
    return { kind: 'none', name, reason: 'This file is too large to show here. Download it to open it.' }
  }

  const mime = IMAGE_TYPES[extension]
  if (mime !== undefined) {
    return { kind: 'image', name, mime, ...(withBytes ? { data: (await readFile(target)).toString('base64') } : {}) }
  }
  if (extension === '.pdf') {
    return { kind: 'pdf', name, ...(withBytes ? { data: (await readFile(target)).toString('base64') } : {}) }
  }

  try {
    if (WORKBOOKS.includes(extension)) return { kind: 'pages', name, pages: await workbookPages(target) }
    if (TABLES.includes(extension)) return { kind: 'pages', name, pages: await tablePages(target) }
    if (extension === '.docx') return { kind: 'pages', name, pages: [await documentPage(target)] }
    if (extension === '.pptx') return { kind: 'pages', name, pages: [await slidesPage(target)] }
  } catch (error) {
    return { kind: 'none', name, reason: `This file could not be read: ${(error as Error).message}` }
  }

  const bytes = await readFile(target)
  if (bytes.subarray(0, 8000).includes(0)) {
    return { kind: 'none', name, reason: 'There is no preview for this kind of file. Download it to open it.' }
  }
  const text = bytes.subarray(0, MAX_TEXT).toString('utf8')
  const note = bytes.byteLength > MAX_TEXT ? `First ${formatBytes(MAX_TEXT)} of ${formatBytes(bytes.byteLength)}` : undefined
  // A page is drawn as the page it is — in a sandbox, so its scripts never run.
  if (extension === '.html' || extension === '.htm') {
    return { kind: 'pages', name, pages: [{ label: name, html: text, ...(note !== undefined ? { note } : {}) }] }
  }
  return {
    kind: 'pages',
    name,
    pages: [{ label: name, html: page(TEXT_STYLE, `<pre>${escape(text)}</pre>`), ...(note !== undefined ? { note } : {}) }]
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

function formatBytes(size: number): string {
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function page(style: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>${body}</body></html>`
}

const TEXT_STYLE = `
html,body{margin:0;background:#1a1a1a;color:#ededed}
pre{margin:0;padding:16px 18px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}`

/* ---------- Workbooks ---------- */

/**
 * A sheet drawn the way Excel draws it: white paper, grey row and column
 * headings, and the cell formatting the file carries — fills, font colours,
 * weight, alignment, borders and merges — so a request like "turn the red
 * header green" can be checked by looking.
 */
const SHEET_STYLE = `
html,body{margin:0;background:#fff;color:#000}
body{font:11pt/1.3 Calibri,Carlito,-apple-system,'Segoe UI',sans-serif}
table{border-collapse:collapse;table-layout:fixed}
td,th{border:1px solid #e2e2e2;padding:1px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
th{background:#f3f3f3;color:#666;font:500 11px/1.2 -apple-system,'Segoe UI',sans-serif;text-align:center}
thead th{position:sticky;top:0;z-index:2;height:20px}
tbody th{position:sticky;left:0;z-index:1;min-width:34px}
thead th:first-child{left:0;z-index:3}
.num{text-align:right}
.empty{padding:24px;color:#777;font:13px -apple-system,'Segoe UI',sans-serif}`

/** Office's default theme, in the order a cell's `theme` index counts. */
const THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47']

function colourOf(colour: Partial<ExcelJS.Color> & { tint?: number } | undefined): string | null {
  if (colour === undefined) return null
  let hex: string | undefined
  if (typeof colour.argb === 'string' && colour.argb.length >= 6) hex = colour.argb.slice(-6)
  else if (typeof colour.theme === 'number') hex = THEME[colour.theme]
  if (hex === undefined || !/^[0-9a-f]{6}$/i.test(hex)) return null
  const tint = typeof colour.tint === 'number' ? colour.tint : 0
  if (tint === 0) return `#${hex}`
  const channel = (offset: number): string => {
    const value = parseInt(hex.slice(offset, offset + 2), 16)
    const tinted = tint < 0 ? value * (1 + tint) : value + (255 - value) * tint
    return Math.round(Math.min(255, Math.max(0, tinted))).toString(16).padStart(2, '0')
  }
  return `#${channel(0)}${channel(2)}${channel(4)}`
}

function edge(side: Partial<ExcelJS.Border> | undefined): string | null {
  if (side?.style === undefined) return null
  const width = side.style === 'thick' ? 3 : side.style === 'medium' || side.style === 'mediumDashed' ? 2 : 1
  const line = /dash|dot/i.test(side.style) ? 'dashed' : side.style === 'double' ? 'double' : 'solid'
  return `${width}px ${line} ${colourOf(side.color) ?? '#000'}`
}

function cellStyle(cell: ExcelJS.Cell): string {
  const rules: string[] = []
  const fill = cell.fill
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const colour = colourOf(fill.fgColor)
    if (colour !== null) rules.push(`background:${colour}`)
  } else if (fill?.type === 'gradient') {
    const colour = colourOf(fill.stops[0]?.color)
    if (colour !== null) rules.push(`background:${colour}`)
  }
  const font = cell.font as Partial<ExcelJS.Font> | undefined
  const colour = colourOf(font?.color)
  if (colour !== null) rules.push(`color:${colour}`)
  if (font?.bold === true) rules.push('font-weight:700')
  if (font?.italic === true) rules.push('font-style:italic')
  const lines = [font?.underline ? 'underline' : '', font?.strike === true ? 'line-through' : ''].filter(Boolean)
  if (lines.length > 0) rules.push(`text-decoration:${lines.join(' ')}`)
  if (typeof font?.size === 'number' && font.size !== 11) rules.push(`font-size:${font.size}pt`)
  const alignment = cell.alignment as Partial<ExcelJS.Alignment> | undefined
  const horizontal = alignment?.horizontal
  if (horizontal === 'center' || horizontal === 'centerContinuous') rules.push('text-align:center')
  else if (horizontal === 'right') rules.push('text-align:right')
  else if (horizontal === 'left') rules.push('text-align:left')
  if (alignment?.vertical === 'middle') rules.push('vertical-align:middle')
  else if (alignment?.vertical === 'top') rules.push('vertical-align:top')
  if (alignment?.wrapText === true) rules.push('white-space:pre-wrap')
  const border = cell.border as Partial<ExcelJS.Borders> | undefined
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const value = edge(border?.[side])
    if (value !== null) rules.push(`border-${side}:${value}`)
  }
  return rules.join(';')
}

function formatNumber(value: number, format: string | undefined): string {
  if (format === undefined || format === '' || format === 'General' || format === '@') {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
  }
  const section = format.split(';')[0] ?? format
  const decimals = /\.(0+)/.exec(section)?.[1]?.length ?? 0
  const percent = section.includes('%')
  const grouped = section.includes(',')
  const shown = (percent ? value * 100 : value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped
  })
  return percent ? `${shown}%` : shown
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function displayOf(cell: ExcelJS.Cell): { text: string; number: boolean } {
  const format = cell.numFmt
  const show = (value: unknown): { text: string; number: boolean } => {
    if (value === null || value === undefined) return { text: '', number: false }
    if (typeof value === 'number') return { text: formatNumber(value, format), number: true }
    if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', number: false }
    if (value instanceof Date) {
      const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
      const time = value.getUTCHours() + value.getUTCMinutes() + value.getUTCSeconds() > 0
      return { text: time ? `${date} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}` : date, number: true }
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      if ('result' in record || 'formula' in record || 'sharedFormula' in record) return show(record['result'])
      if ('richText' in record) {
        return { text: (record['richText'] as { text: string }[]).map((part) => part.text).join(''), number: false }
      }
      if ('text' in record) return { text: String(record['text']), number: false }
      if ('error' in record) return { text: String(record['error']), number: false }
    }
    return { text: String(value), number: false }
  }
  return show(cell.value)
}

async function workbookPages(target: string): Promise<PreviewPage[]> {
  const book = await openWorkbook(target)
  const sheets = book.worksheets.filter((sheet) => sheet.state === 'visible' || sheet.state === undefined)
  const pages = sheets.slice(0, MAX_SHEETS).map(sheetPage)
  return pages.length > 0 ? pages : [{ label: 'Sheet', html: page(SHEET_STYLE, '<div class="empty">This workbook has no sheets.</div>') }]
}

function sheetPage(sheet: ExcelJS.Worksheet): PreviewPage {
  const rowCount = Math.min(sheet.rowCount, MAX_ROWS)
  const columnCount = Math.min(sheet.columnCount, MAX_COLUMNS)
  if (rowCount === 0 || columnCount === 0) {
    return { label: sheet.name, html: page(SHEET_STYLE, '<div class="empty">This sheet is empty.</div>') }
  }

  // Merged ranges: the top-left cell spans, the cells it covers are skipped.
  const spans = new Map<string, { rows: number; columns: number }>()
  const covered = new Set<string>()
  for (const range of sheet.model.merges ?? []) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)
    if (match === null) continue
    const [top, left, bottom, right] = [Number(match[2]), columnIndex(match[1] ?? 'A'), Number(match[4]), columnIndex(match[3] ?? 'A')]
    spans.set(`${top}:${left}`, { rows: bottom - top + 1, columns: right - left + 1 })
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) if (r !== top || c !== left) covered.add(`${r}:${c}`)
  }

  // Alike cells share one class, so a styled header costs one rule, not one per cell.
  const classes = new Map<string, string>()
  const classFor = (style: string): string => {
    let name = classes.get(style)
    if (name === undefined) {
      name = `s${classes.size}`
      classes.set(style, name)
    }
    return name
  }

  const visibleColumns: number[] = []
  for (let c = 1; c <= columnCount; c++) if (sheet.getColumn(c).hidden !== true) visibleColumns.push(c)

  const colgroup = ['<col style="width:36px">']
  const head = ['<th></th>']
  for (const c of visibleColumns) {
    const width = sheet.getColumn(c).width ?? 8.43
    colgroup.push(`<col style="width:${Math.round(width * 7 + 5)}px">`)
    head.push(`<th>${columnName(c)}</th>`)
  }

  const body: string[] = []
  for (let r = 1; r <= rowCount; r++) {
    const row = sheet.getRow(r)
    if (row.hidden) continue
    const height = typeof row.height === 'number' ? ` style="height:${Math.round(row.height * 4 / 3)}px"` : ''
    const cells = [`<th>${r}</th>`]
    for (const c of visibleColumns) {
      if (covered.has(`${r}:${c}`)) continue
      const cell = row.getCell(c)
      const { text, number } = displayOf(cell)
      const span = spans.get(`${r}:${c}`)
      const attributes: string[] = []
      if (span !== undefined) {
        if (span.rows > 1) attributes.push(`rowspan="${span.rows}"`)
        if (span.columns > 1) attributes.push(`colspan="${span.columns}"`)
      }
      const style = cellStyle(cell)
      const names = [number ? 'num' : '', style !== '' ? classFor(style) : ''].filter(Boolean)
      if (names.length > 0) attributes.push(`class="${names.join(' ')}"`)
      cells.push(`<td${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>${escape(text)}</td>`)
    }
    body.push(`<tr${height}>${cells.join('')}</tr>`)
  }

  const rules = [...classes].map(([style, name]) => `.${name}{${style}}`).join('\n')
  const cut = [
    sheet.rowCount > MAX_ROWS ? `first ${MAX_ROWS.toLocaleString('en-US')} of ${sheet.rowCount.toLocaleString('en-US')} rows` : '',
    sheet.columnCount > MAX_COLUMNS ? `first ${MAX_COLUMNS} of ${sheet.columnCount} columns` : ''
  ].filter(Boolean)
  return {
    label: sheet.name,
    html: page(
      `${SHEET_STYLE}\n${rules}`,
      `<table><colgroup>${colgroup.join('')}</colgroup><thead><tr>${head.join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`
    ),
    ...(cut.length > 0 ? { note: `Showing the ${cut.join(' and ')}` } : {})
  }
}

function columnIndex(name: string): number {
  let index = 0
  for (const char of name) index = index * 26 + (char.charCodeAt(0) - 64)
  return index
}

/** CSV and friends carry no formatting; they get the same grid, plainly. */
async function tablePages(target: string): Promise<PreviewPage[]> {
  // SheetJS reads bytes, not paths, inside Electron (see tools/excel.ts).
  const book = XLSX.read(await readFile(target), { type: 'buffer', raw: true })
  return book.SheetNames.slice(0, MAX_SHEETS).map((sheetName) => {
    const sheet = book.Sheets[sheetName]
    const rows = sheet === undefined ? [] : XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false })
    const columns = Math.min(MAX_COLUMNS, rows.reduce((most, row) => Math.max(most, row.length), 0))
    const head = ['<th></th>', ...Array.from({ length: columns }, (_, i) => `<th>${columnName(i + 1)}</th>`)]
    const body = rows.slice(0, MAX_ROWS).map((row, r) => {
      const cells = Array.from({ length: columns }, (_, c) => {
        const text = String(row[c] ?? '')
        return `<td${/^-?[\d.,]+%?$/.test(text) ? ' class="num"' : ''}>${escape(text)}</td>`
      })
      return `<tr><th>${r + 1}</th>${cells.join('')}</tr>`
    })
    return {
      label: book.SheetNames.length > 1 ? sheetName : path.basename(target),
      html:
        rows.length === 0
          ? page(SHEET_STYLE, '<div class="empty">This file is empty.</div>')
          : page(`${SHEET_STYLE}\ntd{min-width:64px;max-width:320px}`, `<table><thead><tr>${head.join('')}</tr></thead><tbody>${body.join('')}</tbody></table>`),
      ...(rows.length > MAX_ROWS ? { note: `Showing the first ${MAX_ROWS} of ${rows.length.toLocaleString('en-US')} rows` } : {})
    }
  })
}

/* ---------- Word and PowerPoint ---------- */

const PAPER_STYLE = `
html{background:#e9e9e9}
body{margin:24px auto;max-width:760px;background:#fff;color:#111;padding:56px 64px;box-shadow:0 1px 4px rgba(0,0,0,.18);
  font:11pt/1.5 Calibri,Carlito,-apple-system,'Segoe UI',sans-serif;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{border-collapse:collapse;margin:8px 0}
td,th{border:1px solid #bbb;padding:4px 8px;vertical-align:top}
h1,h2,h3{line-height:1.25}
@media (max-width:640px){body{margin:0;padding:22px 18px;box-shadow:none}}`

async function documentPage(target: string): Promise<PreviewPage> {
  const { value } = await mammoth.convertToHtml({ path: target })
  const body = value.trim() === '' ? '<p style="color:#777">This document is empty.</p>' : value
  return { label: path.basename(target), html: page(PAPER_STYLE, body) }
}

const SLIDES_STYLE = `
html,body{margin:0;background:#e9e9e9;color:#111;font:15px/1.45 Calibri,Carlito,-apple-system,'Segoe UI',sans-serif}
main{max-width:820px;margin:0 auto;padding:18px}
section{background:#fff;aspect-ratio:16/9;margin:0 0 18px;padding:28px 36px;box-shadow:0 1px 4px rgba(0,0,0,.18);overflow:hidden;position:relative}
section h2{margin:0 0 10px;font-size:22px}
section p{margin:0 0 6px}
section .n{position:absolute;right:14px;bottom:10px;font-size:11px;color:#999}
.hint{color:#777;font-size:12.5px;margin:0 0 14px}`

/** A deck has no renderer here, so each slide shows the words on it, in order. */
async function slidesPage(target: string): Promise<PreviewPage> {
  const zip = await JSZip.loadAsync(await readFile(target))
  const slides = Object.keys(zip.files)
    .map((file) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(file))
    .filter((match): match is RegExpExecArray => match !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
  const sections: string[] = []
  for (const [index, match] of slides.entries()) {
    const xml = (await zip.file(match[0])?.async('string')) ?? ''
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((paragraph) => [...(paragraph[1] ?? '').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((run) => decodeXml(run[1] ?? '')).join(''))
      .filter((text) => text.trim() !== '')
    const [first, ...rest] = paragraphs
    sections.push(
      `<section>${first !== undefined ? `<h2>${escape(first)}</h2>` : ''}${rest.map((text) => `<p>${escape(text)}</p>`).join('')}<span class="n">${index + 1}</span></section>`
    )
  }
  const body = sections.length === 0
    ? '<main><p class="hint">This presentation has no slides.</p></main>'
    : `<main><p class="hint">The text of each slide; layout and pictures are not shown.</p>${sections.join('')}</main>`
  return { label: path.basename(target), html: page(SLIDES_STYLE, body) }
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}
