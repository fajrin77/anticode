import { readFile, writeFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import { PDFDocument } from 'pdf-lib'
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
