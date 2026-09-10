import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const sessions = vi.hoisted(() => new Map<string, { mode: 'code' | 'chat'; root: string | null }>())
vi.mock('../runtime', () => ({
  // The desktop's active folder, which a phone upload must not depend on.
  getStatus: () => ({ workspaceRoot: null }),
  sessionMode: (id: string) => sessions.get(id)?.mode ?? null,
  sessionFileRoot: (id: string) => sessions.get(id)?.root ?? null
}))
import { attachmentsFor, blocksOf, registerAttachmentData } from './registry'

let root: string
/** antichat's private folder, which the app keeps in its own data. */
let chatRoot: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-registry-'))
  chatRoot = await mkdtemp(path.join(tmpdir(), 'anticode-antichat-'))
  sessions.set('code', { mode: 'code', root })
  sessions.set('chat', { mode: 'chat', root: chatRoot })
})

afterEach(async () => {
  sessions.clear()
  await rm(root, { recursive: true, force: true })
  await rm(chatRoot, { recursive: true, force: true })
})

it('lands a phone upload inside the code session it was sent to', async () => {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Import Data').addRow(['NO. PART', 'NAMA'])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const [staged] = await registerAttachmentData('Template_Import_Data_Barang.xlsx', bytes)
  const [sent] = await attachmentsFor('code', [staged?.id ?? ''])
  expect(sent?.workspacePath).toBe(path.join('.anticode', 'uploads', 'Template_Import_Data_Barang.xlsx'))
  expect((await readFile(sent?.path ?? '')).equals(bytes)).toBe(true)

  const blocks = await blocksOf('code', sent === undefined ? [] : [sent])
  const header = blocks[0]
  expect(header?.type === 'text' && header.text).toContain('tools can read it directly')
  // The card the transcript draws points at the copy, which outlives the temp file.
  expect(header?.type === 'text' && header.attachment?.path).toBe(sent?.path)
})

it('lands a chat upload in antichat\'s own folder, ready to edit without choosing one', async () => {
  const [staged] = await registerAttachmentData('catatan.txt', Buffer.from('halo'))
  const [sent] = await attachmentsFor('chat', [staged?.id ?? ''])
  // Top level, no .anticode/uploads: the download carries the file's own name.
  expect(sent?.workspacePath).toBe('catatan.txt')
  expect(sent?.path).toBe(path.join(chatRoot, 'catatan.txt'))
  expect(sent?.path.startsWith(root)).toBe(false)
  expect(await readFile(sent?.path ?? '', 'utf8')).toBe('halo')
  const blocks = await blocksOf('chat', sent === undefined ? [] : [sent])
  const header = blocks[0]?.type === 'text' ? blocks[0].text : ''
  expect(header).toContain("this conversation's own folder at `catatan.txt`")
  expect(header).toContain('can read and edit it')
})

it('refuses an id that was already used or dropped', async () => {
  await expect(attachmentsFor('code', ['gone'])).rejects.toThrow(/no longer available/)
})
