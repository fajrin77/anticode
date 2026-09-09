import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { Document, Packer, Paragraph } from 'docx'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addExcelFormulaTool, readExcelTool, writeExcelCellTool } from './excel'
import { readDocxTool, writeDocxTool } from './docx'
import { fillPdfFormTool, readPdfTool } from './pdf'
import { prepareAttachment, toContentBlocks } from '../attachments'
import type { ToolContext } from './types'

let root: string
let context: ToolContext

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-office-'))
  context = { workspaceRoot: root, signal: new AbortController().signal }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeWorkbook(): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Penjualan')
  sheet.addRow(['produk', 'jumlah'])
  sheet.addRow(['pena', 10])
  sheet.addRow(['buku', 25])
  const file = path.join(root, 'data.xlsx')
  await workbook.xlsx.writeFile(file)
  return file
}

async function makeDocx(): Promise<string> {
  const document = new Document({
    sections: [{ children: [new Paragraph('Judul Laporan'), new Paragraph('Isi paragraf.')] }]
  })
  const file = path.join(root, 'laporan.docx')
  await writeFile(file, await Packer.toBuffer(document))
  return file
}

async function makePdf(withForm: boolean): Promise<string> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([300, 200])
  page.drawText('Dokumen uji', { x: 20, y: 160, size: 14, font })

  if (withForm) {
    const field = document.getForm().createTextField('nama')
    field.addToPage(page, { x: 20, y: 100, width: 200, height: 20 })
  }

  const file = path.join(root, withForm ? 'form.pdf' : 'dokumen.pdf')
  await writeFile(file, await document.save())
  return file
}

describe('excel tools', () => {
  it('reads a sheet as a numbered table', async () => {
    await makeWorkbook()
    const output = (await readExcelTool.prepare({ path: 'data.xlsx' }).execute(context)).text
    expect(output).toContain('Active sheet: Penjualan')
    expect(output).toContain('produk\tjumlah')
    expect(output).toContain('buku\t25')
  })

  it('names the available sheets when one is missing', async () => {
    await makeWorkbook()
    await expect(
      readExcelTool.prepare({ path: 'data.xlsx', sheet: 'Tidak Ada' }).execute(context)
    ).rejects.toThrow(/Available: Penjualan/)
  })

  it('stores a numeric string as a number', async () => {
    const file = await makeWorkbook()
    await writeExcelCellTool.prepare({ path: 'data.xlsx', cell: 'B2', value: '42' }).execute(context)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(file)
    expect(workbook.getWorksheet('Penjualan')?.getCell('B2').value).toBe(42)
  })

  it('keeps non-numeric input as text', async () => {
    const file = await makeWorkbook()
    await writeExcelCellTool
      .prepare({ path: 'data.xlsx', cell: 'A2', value: 'pensil' })
      .execute(context)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(file)
    expect(workbook.getWorksheet('Penjualan')?.getCell('A2').value).toBe('pensil')
  })

  it('previews a cell edit as before and after', async () => {
    await makeWorkbook()
    const preview = await writeExcelCellTool
      .prepare({ path: 'data.xlsx', cell: 'B2', value: '99' })
      .preview(context)
    expect(preview.detail).toContain('before: 10')
    expect(preview.detail).toContain('after: 99')
  })

  it('writes a formula and strips a leading equals sign', async () => {
    const file = await makeWorkbook()
    await addExcelFormulaTool
      .prepare({ path: 'data.xlsx', cell: 'B4', formula: '=SUM(B2:B3)' })
      .execute(context)

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(file)
    const value = workbook.getWorksheet('Penjualan')?.getCell('B4').value as { formula: string }
    expect(value.formula).toBe('SUM(B2:B3)')
  })

  it('rejects a malformed cell address', () => {
    expect(() => writeExcelCellTool.prepare({ path: 'a.xlsx', cell: '4B', value: 'x' })).toThrow(
      /Invalid input/
    )
  })
})

describe('docx tools', () => {
  it('reads a document as markdown', async () => {
    await makeDocx()
    const output = (await readDocxTool.prepare({ path: 'laporan.docx' }).execute(context)).text
    expect(output).toContain('Judul Laporan')
    expect(output).toContain('Isi paragraf.')
  })

  it('writes a document that reads back', async () => {
    await writeDocxTool
      .prepare({ path: 'baru.docx', content: '# Judul\n\nSatu paragraf.\n- butir' })
      .execute(context)

    const output = (await readDocxTool.prepare({ path: 'baru.docx' }).execute(context)).text
    expect(output).toContain('Judul')
    expect(output).toContain('Satu paragraf.')
    expect(output).toContain('butir')
  })
})

describe('pdf tools', () => {
  it('extracts text and page count', async () => {
    await makePdf(false)
    const output = (await readPdfTool.prepare({ path: 'dokumen.pdf' }).execute(context)).text
    expect(output).toContain('PDF · 1 pages')
    expect(output).toContain('Dokumen uji')
  })

  it('lists form fields when none are supplied', async () => {
    await makePdf(true)
    const output = (await fillPdfFormTool.prepare({ path: 'form.pdf' }).execute(context)).text
    expect(output).toContain('nama')
  })

  it('fills a field and writes to the output path', async () => {
    await makePdf(true)
    await fillPdfFormTool
      .prepare({ path: 'form.pdf', fields: { nama: 'Asani' }, output_path: 'terisi.pdf' })
      .execute(context)

    const document = await PDFDocument.load(await readFile(path.join(root, 'terisi.pdf')))
    expect(document.getForm().getTextField('nama').getText()).toBe('Asani')
  })

  it('names the real fields when the requested one is absent', async () => {
    await makePdf(true)
    await expect(
      fillPdfFormTool.prepare({ path: 'form.pdf', fields: { salah: 'x' } }).execute(context)
    ).rejects.toThrow(/Existing fields: nama/)
  })
})

describe('attachment handler', () => {
  it('downscales a large image and sends it as an image block', async () => {
    const file = path.join(root, 'besar.png')
    await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#336699' }
    })
      .png()
      .toFile(file)

    const attachment = await prepareAttachment(file, root)
    expect(attachment.kind).toBe('image')
    expect(attachment.workspacePath).toBe('besar.png')

    const blocks = await toContentBlocks(attachment)
    const image = blocks.find((block) => block.type === 'image')
    expect(image?.type === 'image' && image.mediaType).toBe('image/jpeg')

    const decoded = image?.type === 'image' ? Buffer.from(image.data, 'base64') : Buffer.alloc(0)
    const meta = await sharp(decoded).metadata()
    expect(meta.width).toBe(1568)
  })

  it('keeps transparency by encoding as png', async () => {
    const file = path.join(root, 'alpha.png')
    await sharp({ create: { width: 40, height: 40, channels: 4, background: '#00000000' } })
      .png()
      .toFile(file)

    const blocks = await toContentBlocks(await prepareAttachment(file, root))
    const image = blocks.find((block) => block.type === 'image')
    expect(image?.type === 'image' && image.mediaType).toBe('image/png')
  })

  it('summarises a workbook without a tool call', async () => {
    const file = await makeWorkbook()
    const attachment = await prepareAttachment(file, root)
    expect(attachment.kind).toBe('excel')
    expect(attachment.preview).toContain('Penjualan')
    expect(attachment.preview).toContain('buku')
  })

  it('marks a file outside the workspace as unreachable by tools', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'anticode-outside-'))
    const file = path.join(outside, 'catatan.txt')
    await writeFile(file, 'halo')

    const attachment = await prepareAttachment(file, root)
    expect(attachment.workspacePath).toBeNull()

    const blocks = await toContentBlocks(attachment)
    expect(blocks[0]?.type === 'text' && blocks[0].text).toContain('outside the workspace')
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses a file over the size limit', async () => {
    const file = path.join(root, 'besar.bin')
    await writeFile(file, Buffer.alloc(21 * 1024 * 1024))
    await expect(prepareAttachment(file, root)).rejects.toThrow(/too large/)
  })
})
