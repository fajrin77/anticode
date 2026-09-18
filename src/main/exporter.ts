import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CONTINUE_PROMPT } from '@shared/ipc'
import type { AttachmentRef, ExportOptions, RunSummary, SessionSpec, SnapshotBlock, SnapshotMessage } from '@shared/ipc'

/*
 * A transcript saved to a file: the whole session or a stretch of its
 * prompts, as Markdown or JSON, with secrets masked, and, when asked, the
 * files it carried and produced copied into a folder beside it.
 */

/** Documents the agent produced, by extension, the same kinds the transcript offers as downloads. */
const PRODUCED = /\.(pdf|xlsx|xlsm|xls|docx|csv|pptx|zip|png|jpe?g|webp|gif)$/i
const PRODUCING_TOOLS = new Set([
  'write_file',
  'create_excel',
  'write_excel_cell',
  'add_excel_formula',
  'format_excel_cells',
  'write_docx',
  'create_pdf',
  'fill_pdf_form',
  'generate_image'
])

export function isTypedSnapshotPrompt(message: SnapshotMessage): boolean {
  if (message.role !== 'user' || message.blocks.some((block) => block.type === 'tool_result')) return false
  return message.blocks.some((block) => block.type === 'text' && block.followUp === undefined && block.text !== CONTINUE_PROMPT)
}

/** Runs that got an answer, one summary each, lined up from the end. */
function answered(messages: SnapshotMessage[]): number {
  let runs = 0
  messages.forEach((message, index) => {
    if (message.role !== 'user' || message.blocks.some((block) => block.type === 'tool_result')) return
    if (messages[index + 1]?.role === 'assistant') runs += 1
  })
  return runs
}

/**
 * Prompts `from` through `to` (0-based, typed prompts only) and everything
 * each one led to, with the run summaries that belong to them.
 */
export function selectRange(
  messages: SnapshotMessage[],
  summaries: RunSummary[],
  range: { from: number; to: number } | null
): { messages: SnapshotMessage[]; summaries: RunSummary[] } {
  if (range === null) return { messages, summaries }
  const prompts = messages.flatMap((message, index) => (isTypedSnapshotPrompt(message) ? [index] : []))
  const from = Math.max(0, Math.min(range.from, range.to))
  const to = Math.min(prompts.length - 1, Math.max(range.from, range.to))
  if (prompts.length === 0 || from > to) return { messages: [], summaries: [] }
  const start = prompts[from] ?? 0
  const end = prompts[to + 1] ?? messages.length
  const selected = messages.slice(start, end)
  // Summaries line up with answered runs from the end of the whole session.
  const offset = answered(messages) - summaries.length
  const before = answered(messages.slice(0, start)) - offset
  const within = answered(selected)
  return { messages: selected, summaries: summaries.slice(Math.max(0, before), Math.max(0, before + within)) }
}

/** Patterns of well-known credentials; the value is replaced, its label kept. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
]

/** `api_key = …`, `"password": "…"`, `Authorization: Bearer …`. */
const LABELLED = /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|passwd|token)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g

export const REDACTED = '[REDACTED]'

/** Masks the secrets this app knows by value, then anything that looks like one. */
export function redactText(text: string, known: string[]): string {
  let result = text
  for (const secret of known) {
    if (secret.length >= 8) result = result.split(secret).join(REDACTED)
  }
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, REDACTED)
  result = result.replace(LABELLED, (_match, label: string, value: string) => (value === REDACTED ? `${label}${value}` : `${label}${REDACTED}`))
  result = result.replace(BEARER, (_match, label: string) => `${label}${REDACTED}`)
  return result
}

/** Every string inside, masked; structure and keys left as they are. */
export function redactDeep<T>(value: T, known: string[]): T {
  if (typeof value === 'string') return redactText(value, known) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, known)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item, known)])) as T
  }
  return value
}

export interface ExportAsset {
  /** Where the file is now. */
  source: string
  /** Its name in the assets folder. */
  name: string
  /** Sent with a prompt, or written by a tool. */
  kind: 'attachment' | 'produced'
}

/**
 * The files the selected stretch carried (attachments) and produced (the
 * documents its tools wrote), each once, with names unique in one folder.
 */
export function assetsOf(messages: SnapshotMessage[], fileRoot: string | null): { assets: ExportAsset[]; byKey: Map<string, string> } {
  const assets: ExportAsset[] = []
  const byKey = new Map<string, string>()
  const taken = new Set<string>()
  const add = (key: string, source: string, base: string, kind: ExportAsset['kind']): void => {
    if (byKey.has(key)) return
    const extension = path.extname(base)
    const stem = path.basename(base, extension)
    let name = `${stem}${extension}`
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${extension}`
    taken.add(name.toLowerCase())
    byKey.set(key, name)
    assets.push({ source, name, kind })
  }
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'attachment') {
        const copy = fileRoot !== null && block.attachment.workspacePath !== null ? path.join(fileRoot, block.attachment.workspacePath) : null
        add(attachmentKey(block.attachment), copy ?? block.attachment.path, block.attachment.name, 'attachment')
      } else if (block.type === 'tool_use' && PRODUCING_TOOLS.has(block.name) && fileRoot !== null) {
        const input = block.input as { path?: unknown; output_path?: unknown } | null
        const target = typeof input?.output_path === 'string' ? input.output_path : input?.path
        if (typeof target === 'string' && PRODUCED.test(target)) add(`produced:${target}`, path.resolve(fileRoot, target), path.basename(target), 'produced')
      }
    }
  }
  return { assets, byKey }
}

function attachmentKey(attachment: AttachmentRef): string {
  return `attachment:${attachment.workspacePath ?? attachment.path}`
}

function blockMarkdown(block: SnapshotBlock, links: Map<string, string> | null, folder: string): string {
  if (block.type === 'text') return block.text
  if (block.type === 'display') return block.kind === 'error' ? `**Error:** ${block.text}` : `_${block.text}_`
  if (block.type === 'attachment') {
    const file = links?.get(attachmentKey(block.attachment))
    if (file === undefined) return `[Attachment: ${block.attachment.name}]`
    const href = `${encodeURI(folder)}/${encodeURI(file)}`
    return block.attachment.kind === 'image' ? `![${block.attachment.name}](${href})` : `[Attachment: ${block.attachment.name}](${href})`
  }
  if (block.type === 'tool_use') return `\n\`\`\`json\n${JSON.stringify({ tool: block.name, input: block.input }, null, 2)}\n\`\`\``
  const body = block.diff !== undefined ? `\`\`\`diff\n${block.diff}\n\`\`\`` : `\`\`\`text\n${block.content}\n\`\`\``
  return `\n${block.isError ? '**Tool error**\n\n' : ''}${body}`
}

export function transcriptMarkdown(
  title: string,
  messages: SnapshotMessage[],
  options: { links: Map<string, string> | null; folder: string; produced: string[]; note: string | null }
): string {
  return [
    `# ${title}`,
    '',
    ...(options.note !== null ? [`_${options.note}_`, ''] : []),
    ...messages.flatMap((message) => [
      `## ${message.role === 'user' ? 'User' : 'Assistant'}`,
      '',
      message.blocks.map((block) => blockMarkdown(block, options.links, options.folder)).join('\n\n'),
      ''
    ]),
    ...(options.produced.length > 0
      ? ['## Files produced', '', ...options.produced.map((name) => `- [${name}](${encodeURI(options.folder)}/${encodeURI(name)})`), '']
      : [])
  ].join('\n')
}

/**
 * Writes the export to `target` and, with assets, a `<name>-assets` folder
 * beside it. Files that are gone are listed as missing rather than failing
 * the whole export. Answers what was written.
 */
export async function writeExport(
  target: string,
  input: {
    spec: SessionSpec
    messages: SnapshotMessage[]
    summaries: RunSummary[]
    fileRoot: string | null
    options: ExportOptions
    knownSecrets: string[]
  }
): Promise<{ path: string; assets: number; missing: string[] }> {
  const { options } = input
  const selected = selectRange(input.messages, input.summaries, options.range)
  const secrets = options.redact ? input.knownSecrets : []
  const messages = options.redact ? redactDeep(selected.messages, secrets) : selected.messages
  const title = input.spec.title ?? 'anticode session'
  const folderName = `${path.basename(target, path.extname(target))}-assets`
  const folder = path.join(path.dirname(target), folderName)
  const missing: string[] = []
  let links: Map<string, string> | null = null
  const written: ExportAsset[] = []
  if (options.assets) {
    const { assets, byKey } = assetsOf(selected.messages, input.fileRoot)
    links = byKey
    for (const asset of assets) {
      const exists = (await stat(asset.source).catch(() => null))?.isFile() === true
      if (!exists) {
        missing.push(asset.name)
        continue
      }
      await mkdir(folder, { recursive: true })
      await copyFile(asset.source, path.join(folder, asset.name))
      written.push(asset)
    }
    // A missing file keeps its plain [Attachment: name] line instead of a dead link.
    for (const name of missing) for (const [key, value] of byKey) if (value === name) byKey.delete(key)
  }
  const promptCount = input.messages.filter(isTypedSnapshotPrompt).length
  const note =
    options.range === null
      ? null
      : `Prompts ${Math.min(options.range.from, options.range.to) + 1}–${Math.max(options.range.from, options.range.to) + 1} of ${promptCount}`
  const produced = written.filter((asset) => asset.kind === 'produced').map((asset) => asset.name)
  const content =
    options.format === 'json'
      ? JSON.stringify(
          {
            session: input.spec,
            ...(options.range !== null ? { range: { ...options.range, of: promptCount } } : {}),
            redacted: options.redact,
            messages,
            summaries: selected.summaries,
            ...(options.assets ? { assets: written.map((asset) => `${folderName}/${asset.name}`), missing } : {})
          },
          null,
          2
        )
      : transcriptMarkdown(options.redact ? redactText(title, secrets) : title, messages, { links, folder: folderName, produced, note })
  await writeFile(target, content, 'utf8')
  return { path: target, assets: written.length, missing }
}
