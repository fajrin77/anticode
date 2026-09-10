import { readFile, writeFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_TEXT_CHARS = 20_000

async function extractText(filePath: string): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: await readFile(filePath) })
  try {
    const result = await parser.getText()
    return { text: result.text, pages: result.total }
  } catch (error) {
    throw new ToolError(`Failed to read PDF: ${(error as Error).message}`)
  } finally {
    await parser.destroy()
  }
}

/** Shared with the attachment handler so a dropped PDF previews the same way. */
export async function summarisePdf(filePath: string): Promise<string> {
  const { text, pages } = await extractText(filePath)
  return `PDF · ${pages} pages\n\n${text}`
}

async function loadForm(filePath: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(await readFile(filePath))
  } catch (error) {
    throw new ToolError(`Failed to open PDF: ${(error as Error).message}`)
  }
}

export const readPdfTool = defineTool({
  name: 'read_pdf',
  description: 'Extract text from a PDF file along with its page count.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('Pdf file path relative to the workspace root')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const { text, pages } = await extractText(target)
    const body =
      text.length > MAX_TEXT_CHARS
        ? `${text.slice(0, MAX_TEXT_CHARS)}\n… text truncated (${text.length} characters total)`
        : text
    return `PDF · ${pages} pages\n\n${body}`
  }
})

export const fillPdfFormTool = defineTool({
  name: 'fill_pdf_form',
  description:
    'Fill fields on a PDF form. Call without fields to see the available field names ' +
    'and their types.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Pdf file path relative to the workspace root'),
    fields: z
      .record(z.string(), z.string())
      .default({})
      .describe('Map of field name to its value; leave empty to just list the fields'),
    output_path: z
      .string()
      .optional()
      .describe('Output path; when empty the original file is overwritten')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: input.output_path ?? input.path,
    detail:
      Object.keys(input.fields).length === 0
        ? 'Only listing the fields, nothing is changed.'
        : Object.entries(input.fields)
            .map(([name, value]) => `${name} = ${value}`)
            .join('\n')
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const document = await loadForm(target)
    const form = document.getForm()
    const available = form.getFields().map((field) => ({
      name: field.getName(),
      type: field.constructor.name
    }))

    if (Object.keys(input.fields).length === 0) {
      return available.length === 0
        ? 'This PDF has no form fields.'
        : `Available fields:\n${available.map((f) => `- ${f.name} (${f.type})`).join('\n')}`
    }

    const filled: string[] = []
    for (const [name, value] of Object.entries(input.fields)) {
      try {
        form.getTextField(name).setText(value)
        filled.push(`${name} = ${value}`)
      } catch {
        const names = available.map((f) => f.name).join(', ')
        throw new ToolError(
          `Text field "${name}" not found. Existing fields: ${names || '(none)'}`
        )
      }
    }

    const destination = resolveInWorkspace(context.workspaceRoot, input.output_path ?? input.path)
    await writeFile(destination, await document.save())
    return `Filled in ${input.output_path ?? input.path}:\n${filled.join('\n')}`
  }
})

/** A4 in points, with a margin wide enough to read comfortably. */
const PAGE = { width: 595.28, height: 841.89, margin: 56 }

/**
 * The standard fonts encode WinAnsi only, so anything outside it would throw
 * mid-document. Typographic punctuation is folded to its ASCII twin and the
 * rest is marked, which beats losing the whole file to one stray glyph.
 */
function toWinAnsi(text: string): string {
  return text
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[•·]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[^	 -~ -ÿ]/g, '?')
}

interface PdfLine {
  text: string
  bold: boolean
  size: number
  indent: number
  /** Extra space above the line, for headings and paragraph breaks. */
  lead: number
}

/** Same markdown subset as write_docx: headings, list items, paragraphs. */
function toLines(markdown: string): PdfLine[] {
  const lines: PdfLine[] = []
  for (const raw of markdown.split('\n')) {
    const line = toWinAnsi(raw.trimEnd())
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      lines.push({
        text: heading[2] ?? '',
        bold: true,
        size: [18, 14.5, 12.5][level - 1] ?? 12.5,
        indent: 0,
        lead: lines.length === 0 ? 0 : 12
      })
      continue
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      lines.push({ text: `- ${bullet[1] ?? ''}`, bold: false, size: 11, indent: 14, lead: 2 })
      continue
    }
    lines.push({ text: line, bold: false, size: 11, indent: 0, lead: line === '' ? 0 : 6 })
  }
  return lines
}

export const createPdfTool = defineTool({
  name: 'create_pdf',
  description:
    'Create a new PDF from simple markdown. Supported: headings (#, ##, ###), list items ' +
    '(- or *), blank lines, and plain paragraphs. Text wraps and pages break automatically.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Destination .pdf path, relative to the workspace root'),
    content: z.string().min(1).describe('Document contents in simple markdown'),
    title: z.string().optional().describe('Document title stored in the PDF metadata')
  }),
  preview: async (input) => ({ kind: 'text', subject: input.path, detail: input.content }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const document = await PDFDocument.create()
    if (input.title !== undefined) document.setTitle(toWinAnsi(input.title))
    const regular = await document.embedFont(StandardFonts.Helvetica)
    const bold = await document.embedFont(StandardFonts.HelveticaBold)

    let page = document.addPage([PAGE.width, PAGE.height])
    let cursor = PAGE.height - PAGE.margin

    const write = (text: string, line: PdfLine): void => {
      const font = line.bold ? bold : regular
      const height = line.size * 1.45
      if (cursor - height < PAGE.margin) {
        page = document.addPage([PAGE.width, PAGE.height])
        cursor = PAGE.height - PAGE.margin
      }
      cursor -= height
      page.drawText(text, { x: PAGE.margin + line.indent, y: cursor, size: line.size, font })
    }

    for (const line of toLines(input.content)) {
      cursor -= line.lead
      if (line.text === '') { cursor -= 6; continue }

      const font = line.bold ? bold : regular
      const maxWidth = PAGE.width - PAGE.margin * 2 - line.indent
      let current = ''
      for (const word of line.text.split(/\s+/)) {
        const candidate = current === '' ? word : `${current} ${word}`
        if (current !== '' && font.widthOfTextAtSize(candidate, line.size) > maxWidth) {
          write(current, line)
          current = word
        } else {
          current = candidate
        }
      }
      if (current !== '') write(current, line)
    }

    try {
      await writeFile(target, await document.save())
    } catch (error) {
      throw new ToolError(`Failed to write PDF: ${(error as Error).message}`)
    }
    return `Saved: ${input.path} (${document.getPageCount()} pages)`
  }
})
