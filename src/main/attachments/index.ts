import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { AttachmentInfo, AttachmentRef, SessionMode } from '@shared/ipc'
import type { ContentBlock } from '../providers/types'
import { summariseExcel } from '../tools/excel'
import { docxToMarkdown } from '../tools/docx'
import { summarisePdf } from '../tools/pdf'
import { resolveInWorkspace } from '../tools/workspace'

/** Where an anticode session keeps the files it was sent, relative to its root. */
export const UPLOADS_DIR = path.join('.anticode', 'uploads')
/** Enough for any sane pile of same-named files; a bound, not a feature. */
const MAX_NAME_ATTEMPTS = 1000

const MAX_BYTES = 100 * 1024 * 1024
const MAX_PREVIEW_CHARS = 2000
/** Anthropic's recommended long edge; larger images cost tokens without helping. */
const MAX_IMAGE_EDGE = 1568
/** Long edge of the picture the chat draws; small enough to live in the transcript. */
const THUMBNAIL_EDGE = 320

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'])
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.tsv', '.yml', '.yaml', '.xml', '.html', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.sh', '.sql', '.toml', '.ini', '.env'
])

export class AttachmentError extends Error {}

function clip(text: string): string {
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n… pratinjau dipotong`
    : text
}

function classify(extension: string): AttachmentInfo['kind'] {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === '.xlsx' || extension === '.xlsm' || extension === '.xls') return 'excel'
  if (extension === '.docx') return 'docx'
  if (extension === '.pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'binary'
}

/**
 * A small picture the UI can draw inline. Kept as a data URL so it survives
 * into the persisted transcript without a second file to look after.
 */
async function buildThumbnail(filePath: string): Promise<string | null> {
  try {
    const data = await sharp(filePath)
      .rotate()
      .resize({ width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer()
    return `data:image/jpeg;base64,${data.toString('base64')}`
  } catch {
    // An unreadable image still attaches; it just shows as a file card.
    return null
  }
}

/**
 * The preview is a courtesy to the model, not a gate on the file: a workbook
 * too large for the Excel tools, or a document that will not parse, still
 * attaches. The model is told why it cannot see inside, and says so.
 */
async function buildPreview(kind: AttachmentInfo['kind'], filePath: string): Promise<string> {
  try {
    return await readPreview(kind, filePath)
  } catch (error) {
    return `(contents not previewed: ${(error as Error).message})`
  }
}

async function readPreview(kind: AttachmentInfo['kind'], filePath: string): Promise<string> {
  switch (kind) {
    case 'text':
      return clip(await readFile(filePath, 'utf8'))
    case 'excel':
      return clip(await summariseExcel(filePath))
    case 'docx':
      return clip(await docxToMarkdown(filePath))
    case 'pdf':
      return clip(await summarisePdf(filePath))
    case 'image':
      return '(image sent as a visual attachment)'
    case 'binary':
      return '(binary file — contents not read)'
  }
}

/**
 * Gives the agent a copy it can reach. A phone upload, a pasted screenshot, or
 * a file dropped from outside the project otherwise lives where no tool may
 * go. In a project the copy lands in `.anticode/uploads/`, which ignores
 * itself in git, so the project's own status stays clean. antichat's folder
 * is private already, so there the copy sits at its top level (`into = ''`)
 * and a download carries the file's own name.
 */
export async function placeInWorkspace(
  attachment: AttachmentInfo,
  root: string,
  into: string = UPLOADS_DIR
): Promise<AttachmentInfo> {
  if (attachment.workspacePath !== null) return attachment
  // Checked before and after creation: an existing `.anticode` that links out
  // of the project must not become a way to write outside it.
  resolveInWorkspace(root, into)
  await mkdir(path.join(root, into), { recursive: true })
  const directory = resolveInWorkspace(root, into)
  if (into === UPLOADS_DIR) {
    await writeFile(path.join(root, '.anticode', '.gitignore'), '*\n', { flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      }
    )
  }

  const source = await readFile(attachment.path)
  const safe = path.basename(attachment.name).replace(/^\.+/, '') || 'attachment'
  const { name, ext } = path.parse(safe)
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const target = path.join(directory, attempt === 1 ? safe : `${name}-${attempt}${ext}`)
    try {
      await writeFile(target, source, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // The same file sent twice is one file: reuse the first copy rather
      // than numbering duplicates. A copy the agent has since edited differs,
      // so it is never overwritten.
      const existing = await readFile(target).catch(() => null)
      if (existing === null || !existing.equals(source)) continue
    }
    return { ...attachment, path: target, workspacePath: path.relative(root, target) }
  }
  throw new AttachmentError(`Too many uploads named ${safe}`)
}

/**
 * Pasted bytes have no file of their own, so one is made for them. It lives in
 * the configured application-data folder so an unsent draft survives reboot.
 */
let attachmentStorage = path.join(tmpdir(), 'anticode-attachments')
export function setAttachmentStorage(directory: string): void { attachmentStorage = directory }

export async function stageAttachmentData(name: string, data: Buffer): Promise<string> {
  if (data.byteLength > MAX_BYTES) {
    throw new AttachmentError(
      `File too large (${Math.round(data.byteLength / 1024 / 1024)} MB, limit 100 MB)`
    )
  }
  const directory = path.join(attachmentStorage, randomUUID())
  await mkdir(directory, { recursive: true })
  // Only the basename, and never a dotfile: the name comes from a phone upload.
  const safe = path.basename(name).replace(/^\.+/, '') || 'attachment'
  const target = path.join(directory, safe)
  await writeFile(target, data)
  return target
}

/**
 * Reads the file once at attach time to build the model-facing preview. The
 * original is left where it is; nothing is copied into the workspace.
 */
export async function prepareAttachment(
  filePath: string,
  workspaceRoot: string | null
): Promise<AttachmentInfo> {
  const info = await stat(filePath).catch(() => null)
  if (info === null || !info.isFile()) throw new AttachmentError(`Not a file: ${filePath}`)
  if (info.size > MAX_BYTES) {
    throw new AttachmentError(
      `File too large (${Math.round(info.size / 1024 / 1024)} MB, limit 100 MB)`
    )
  }

  const kind = classify(path.extname(filePath).toLowerCase())
  const relative =
    workspaceRoot !== null && !path.relative(workspaceRoot, filePath).startsWith('..')
      ? path.relative(workspaceRoot, filePath)
      : null

  return {
    id: randomUUID(),
    name: path.basename(filePath),
    path: filePath,
    workspacePath: relative,
    kind,
    size: info.size,
    thumbnail: kind === 'image' ? await buildThumbnail(filePath) : null,
    preview: await buildPreview(kind, filePath)
  }
}

/** The subset every viewer needs to draw the file; drops the model preview. */
export function toRef(attachment: AttachmentInfo): AttachmentRef {
  return {
    name: attachment.name,
    path: attachment.path,
    workspacePath: attachment.workspacePath,
    kind: attachment.kind,
    size: attachment.size,
    thumbnail: attachment.thumbnail
  }
}

async function toImageBlock(filePath: string): Promise<ContentBlock> {
  const image = sharp(filePath).rotate()
  const meta = await image.metadata()
  const resized = image.resize({
    width: MAX_IMAGE_EDGE,
    height: MAX_IMAGE_EDGE,
    fit: 'inside',
    withoutEnlargement: true
  })

  // PNG only where transparency would otherwise be lost; JPEG is far smaller.
  const encoded = meta.hasAlpha === true
    ? { data: await resized.png({ compressionLevel: 9 }).toBuffer(), mediaType: 'image/png' }
    : { data: await resized.jpeg({ quality: 80 }).toBuffer(), mediaType: 'image/jpeg' }

  return { type: 'image', mediaType: encoded.mediaType, data: encoded.data.toString('base64') }
}

export async function toContentBlocks(
  attachment: AttachmentInfo,
  mode: SessionMode = 'code'
): Promise<ContentBlock[]> {
  const location =
    mode === 'chat'
      ? attachment.workspacePath !== null
        ? `copied into this conversation's own folder at \`${attachment.workspacePath}\` — ` +
          'your document tools can read and edit it there, and what you write is offered as a download'
        : 'sent to antichat, but no copy could be made: the preview below is all you can see of it'
      : attachment.workspacePath !== null
        ? `inside the workspace at \`${attachment.workspacePath}\` — tools can read it directly`
        : 'outside the workspace, so tools cannot open it; copy it into the project folder if it needs editing'

  const header = `Attachment: ${attachment.name} (${attachment.kind}, ${attachment.size} bytes), ${location}.`
  // The reference travels with the header block, which no history-condensing
  // pass ever drops — so the chat can still draw the card turns later.
  const ref = toRef(attachment)

  if (attachment.kind === 'image') {
    return [{ type: 'text', text: header, attachment: ref }, await toImageBlock(attachment.path)]
  }
  return [{ type: 'text', text: `${header}\n\n${attachment.preview}`, attachment: ref }]
}
