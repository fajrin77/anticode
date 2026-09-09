import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import type { AttachmentInfo } from '@shared/ipc'
import type { ContentBlock } from '../providers/types'
import { summariseExcel } from '../tools/excel'
import { docxToMarkdown } from '../tools/docx'
import { summarisePdf } from '../tools/pdf'

const MAX_BYTES = 20 * 1024 * 1024
const MAX_PREVIEW_CHARS = 2000
/** Anthropic's recommended long edge; larger images cost tokens without helping. */
const MAX_IMAGE_EDGE = 1568

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
  if (extension === '.xlsx' || extension === '.xlsm') return 'excel'
  if (extension === '.docx') return 'docx'
  if (extension === '.pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'binary'
}

async function buildPreview(kind: AttachmentInfo['kind'], filePath: string): Promise<string> {
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
      `File too large (${Math.round(info.size / 1024 / 1024)} MB, limit 20 MB)`
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
    preview: await buildPreview(kind, filePath)
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

export async function toContentBlocks(attachment: AttachmentInfo): Promise<ContentBlock[]> {
  const location =
    attachment.workspacePath !== null
      ? `inside the workspace at \`${attachment.workspacePath}\` — tools can read it directly`
      : 'outside the workspace, so tools cannot open it; copy it into the project folder if it needs editing'

  const header = `Attachment: ${attachment.name} (${attachment.kind}, ${attachment.size} bytes), ${location}.`

  if (attachment.kind === 'image') {
    return [{ type: 'text', text: header }, await toImageBlock(attachment.path)]
  }
  return [{ type: 'text', text: `${header}\n\n${attachment.preview}` }]
}
