import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { Document, Packer, Paragraph } from 'docx'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { previewFile } from './preview'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-preview-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function pagesOf(preview: Awaited<ReturnType<typeof previewFile>>): { label: string; html: string; note?: string }[] {
  if (preview.kind !== 'pages') throw new Error(`expected pages, got ${preview.kind}`)
  return preview.pages
}

it('draws a workbook with the formatting a person would check by eye', async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Barang')
  sheet.addRow(['Kode', 'Nama', 'Harga'])
  sheet.addRow(['A-1', 'Pena <biru>', 12500])
  sheet.mergeCells('A3:B3')
  sheet.getCell('A3').value = 'Gabungan'
  for (const address of ['A1', 'B1', 'C1']) {
    const cell = sheet.getCell(address)
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00B050' } }
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  }
  sheet.getCell('C2').numFmt = '#,##0'
  book.addWorksheet('Kosong')
  const file = path.join(root, 'barang.xlsx')
  await book.xlsx.writeFile(file)

  const [first, second] = pagesOf(await previewFile(file, false))
  expect(first?.label).toBe('Barang')
  // The header's fill and white bold text share one rule.
  expect(first?.html).toMatch(/\.s\d\{background:#00B050;color:#FFFFFF;font-weight:700\}/)
  expect(first?.html).toContain('12,500')
  expect(first?.html).toContain('colspan="2"')
  // Cell text is escaped, never markup.
  expect(first?.html).toContain('Pena &#60;biru&#62;')
  expect(first?.html).not.toContain('<script')
  expect(second?.label).toBe('Kosong')
  expect(second?.html).toContain('This sheet is empty')
})

it('draws CSV as a plain grid', async () => {
  const file = path.join(root, 'data.csv')
  await writeFile(file, 'kode,jumlah\nA-1,7\n')
  const [only] = pagesOf(await previewFile(file, false))
  expect(only?.html).toContain('<td>kode</td>')
  expect(only?.html).toContain('<td class="num">7</td>')
})

it('draws a Word document as paper and a deck as the text of its slides', async () => {
  const docx = path.join(root, 'laporan.docx')
  await writeFile(docx, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Isi laporan')] }] })))
  expect(pagesOf(await previewFile(docx, false))[0]?.html).toContain('<p>Isi laporan</p>')

  const zip = new JSZip()
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>Kedua</a:t></a:r></a:p></p:sld>')
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Judul &amp; Isi</a:t></a:r></a:p><a:p><a:r><a:t>Poin</a:t></a:r></a:p></p:sld>')
  const pptx = path.join(root, 'deck.pptx')
  await writeFile(pptx, await zip.generateAsync({ type: 'nodebuffer' }))
  const html = pagesOf(await previewFile(pptx, false))[0]?.html ?? ''
  expect(html.indexOf('Judul &#38; Isi')).toBeGreaterThan(-1)
  expect(html.indexOf('Judul &#38; Isi')).toBeLessThan(html.indexOf('Kedua'))
})

it('shows text as text, and leaves pictures and PDFs to the viewer', async () => {
  const text = path.join(root, 'catatan.md')
  await writeFile(text, '# Judul\n<b>tebal</b>')
  expect(pagesOf(await previewFile(text, false))[0]?.html).toContain('&#60;b&#62;tebal')

  const picture = path.join(root, 'foto.png')
  await writeFile(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  expect(await previewFile(picture, false)).toEqual({ kind: 'image', name: 'foto.png', mime: 'image/png' })
  expect(await previewFile(picture, true)).toMatchObject({ kind: 'image', data: 'iVBORw==' })

  const pdf = path.join(root, 'surat.pdf')
  await writeFile(pdf, '%PDF-1.4')
  expect(await previewFile(pdf, false)).toEqual({ kind: 'pdf', name: 'surat.pdf' })
})

it('says so when there is nothing to draw', async () => {
  const binary = path.join(root, 'arsip.bin')
  await writeFile(binary, Buffer.from([1, 0, 2, 0, 3]))
  expect((await previewFile(binary, false)).kind).toBe('none')
  expect((await previewFile(path.join(root, 'hilang.xlsx'), false)).kind).toBe('none')

  const broken = path.join(root, 'rusak.xlsx')
  await writeFile(broken, 'bukan workbook')
  const preview = await previewFile(broken, false)
  expect(preview.kind).toBe('none')
})
