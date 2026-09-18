import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AttachmentKind, AttachmentRef } from '@shared/ipc'
import { usePreviewStore } from '../store/preview'

/** Fallback tag for a name with no short extension of its own. */
const KIND_TAG: Record<AttachmentKind, string> = {
  image: 'IMG',
  text: 'TXT',
  excel: 'XLSX',
  docx: 'DOCX',
  pdf: 'PDF',
  binary: 'BIN'
}

/**
 * Short tag drawn on a file card. The file's own extension where it has one,
 * so an .xlsx never reads as .xls; the kind only when the name does not say.
 */
export function fileTag(item: { name: string; kind: AttachmentKind }): string {
  const dot = item.name.lastIndexOf('.')
  const extension = dot > 0 ? item.name.slice(dot + 1) : ''
  return /^[a-z0-9]{1,4}$/i.test(extension) ? extension.toUpperCase() : KIND_TAG[item.kind]
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function FileGlyph({ tag }: { tag: string }): JSX.Element {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center">
      <svg width="26" height="30" viewBox="0 0 26 30" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-faint transition-colors group-hover:text-brand">
        <path d="M4 1.5h11L22 8v20.5H4z" />
        <path d="M15 1.5V8h7" />
      </svg>
      <span className="absolute bottom-1 text-[7px] leading-none font-semibold tracking-wider text-dim transition-colors group-hover:text-brand">
        {tag}
      </span>
    </span>
  )
}

/**
 * The files that rode along with a prompt. Images show as pictures because
 * that is what the user actually sent; everything else gets a card naming the
 * file. Clicking either opens it here, in the app.
 */
export function Attachments({
  items,
  align = 'end'
}: {
  items: AttachmentRef[]
  align?: 'start' | 'end'
}): JSX.Element {
  // A picture opens over the conversation at full size; any other file in
  // the file viewer.
  const [viewing, setViewing] = useState<{ name: string; src: string } | null>(null)
  const open = (item: AttachmentRef): void => openAttachment(item, setViewing)

  return (
    // items-end: a file card keeps its own height beside a tall picture instead
    // of stretching to match it, and sits on the line the prompt starts from.
    <div className={`flex flex-wrap items-end gap-2 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {viewing !== null && (
        <ImageViewer
          name={viewing.name}
          src={viewing.src}
          onClose={() => setViewing(null)}
        />
      )}
      {items.map((item, index) =>
        item.thumbnail !== null ? (
          <button
            key={`${item.name}-${index}`}
            type="button"
            onClick={() => open(item)}
            title={`${item.name} · ${formatBytes(item.size)}`}
            className="overflow-hidden rounded-xl border border-line transition-colors hover:border-dim"
          >
            <img
              src={item.thumbnail}
              alt={item.name}
              className="max-h-52 max-w-64 object-cover"
            />
          </button>
        ) : (
          <button
            key={`${item.name}-${index}`}
            type="button"
            onClick={() => open(item)}
            title={item.path}
            className="group flex max-w-72 items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-dim"
          >
            <FileGlyph tag={fileTag(item)} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] text-text transition-colors group-hover:text-brand">
                {item.name}
              </span>
              <span className="block text-[11.5px] text-faint">{formatBytes(item.size)}</span>
            </span>
          </button>
        )
      )}
    </div>
  )
}

/**
 * Opens an attachment the way the transcript does, always inside the app: a
 * picture at full size, anything else, a workbook, a document, a PDF, in
 * the file viewer. Shared by the transcript and the composer, so a staged
 * file can be checked before it is sent.
 */
export function openAttachment(
  item: Pick<AttachmentRef, 'kind' | 'name' | 'path'>,
  show: (picture: { name: string; src: string }) => void
): void {
  const inViewer = (): void =>
    usePreviewStore.getState().open({ kind: 'attachment', path: item.path, name: item.name })
  if (item.kind !== 'image') {
    inViewer()
    return
  }
  void window.anticode.readAttachmentImage(item.path).then((src) => {
    if (src === null) inViewer()
    else show({ name: item.name, src })
  })
}

/** A picture at full size, over the conversation. Escape or a click dismisses. */
export function ImageViewer({
  name,
  src,
  onClose
}: {
  name: string
  src: string
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg/95 p-8"
    >
      <img
        src={src}
        alt={name}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[80vh] max-w-full rounded-lg object-contain"
      />
      <div className="flex items-center gap-3 text-[12.5px] text-faint">
        <span className="max-w-96 truncate font-mono">{name}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 transition-colors hover:text-brand"
        >
          Close
        </button>
      </div>
    </div>
  )
}
