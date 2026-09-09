import { writeFile } from 'node:fs/promises'
import mammoth from 'mammoth'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

// Present at runtime but absent from mammoth's type declarations, which only
// cover the HTML converter.
const convertToMarkdown = (
  mammoth as unknown as {
    convertToMarkdown: (input: { path: string }) => Promise<{ value: string }>
  }
).convertToMarkdown

/**
 * Mammoth escapes punctuation aggressively — plain prose comes back as
 * `paragraf\.` — which only matters when re-rendering the markdown. This output
 * is read by a model, so the escapes are noise and get removed.
 */
function unescapePunctuation(markdown: string): string {
  return markdown.replace(/\\([.\-*_#[\]()`+!>])/g, '$1')
}

/** Shared with the attachment handler so a dropped .docx previews the same way. */
export async function docxToMarkdown(filePath: string): Promise<string> {
  try {
    const result = await convertToMarkdown({ path: filePath })
    const text = unescapePunctuation(result.value).trim()
    return text === '' ? '(dokumen kosong)' : text
  } catch (error) {
    throw new ToolError(`Gagal membaca docx: ${(error as Error).message}`)
  }
}

export const readDocxTool = defineTool({
  name: 'read_docx',
  description: 'Baca dokumen Word (.docx) dan kembalikan isinya sebagai markdown.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    path: z.string().describe('Path berkas .docx relatif terhadap root workspace')
  }),
  execute: async (input, context) =>
    docxToMarkdown(resolveInWorkspace(context.workspaceRoot, input.path))
})

/**
 * A deliberately small markdown subset: headings and paragraphs. Anything richer
 * belongs in a template, not in text the model has to hand-assemble.
 */
function toParagraphs(markdown: string): Paragraph[] {
  return markdown.split('\n').map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3]
      return new Paragraph({
        text: heading[2] ?? '',
        heading: levels[(heading[1] ?? '#').length - 1] ?? HeadingLevel.HEADING_3
      })
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) return new Paragraph({ text: bullet[1] ?? '', bullet: { level: 0 } })
    return new Paragraph({ children: [new TextRun(line)] })
  })
}

export const writeDocxTool = defineTool({
  name: 'write_docx',
  description:
    'Buat dokumen Word (.docx) dari teks markdown sederhana. Didukung: judul (#, ##, ###), ' +
    'butir daftar (- atau *), dan paragraf biasa.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    path: z.string().describe('Path berkas .docx tujuan, relatif terhadap root workspace'),
    content: z.string().min(1).describe('Isi dokumen dalam markdown sederhana')
  }),
  preview: async (input) => ({
    kind: 'text',
    subject: input.path,
    detail: input.content
  }),
  execute: async (input, context) => {
    const target = resolveInWorkspace(context.workspaceRoot, input.path)
    const document = new Document({ sections: [{ children: toParagraphs(input.content) }] })

    try {
      await writeFile(target, await Packer.toBuffer(document))
    } catch (error) {
      throw new ToolError(`Gagal menulis docx: ${(error as Error).message}`)
    }
    return `Tersimpan: ${input.path} (${input.content.split('\n').length} paragraf)`
  }
})
