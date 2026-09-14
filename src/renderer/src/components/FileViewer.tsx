import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { FilePreview } from '@shared/ipc'
import { usePreviewStore } from '../store/preview'
import type { PreviewTarget } from '../store/preview'

function nameOf(target: PreviewTarget): string {
  if (target.kind === 'attachment') return target.name
  return target.path.split(/[\\/]/).filter(Boolean).at(-1) ?? target.path
}

function tagOf(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return /^[a-z0-9]{1,4}$/i.test(extension) ? extension.toUpperCase() : 'FILE'
}

/**
 * A file looked at without leaving the app: a workbook with its colours, a
 * document as paper, a picture, a PDF. It covers the conversation below the
 * tabs; Escape or the cross goes back to it. Rendered pages come from the main
 * process and are drawn in a sandboxed frame, so nothing in a file runs.
 */
export function FileViewer(): JSX.Element {
  const target = usePreviewStore((state) => state.target)
  const close = usePreviewStore((state) => state.close)
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    setPreview(null)
    setFailure(null)
    setPageIndex(0)
    setSaved(null)
    if (target === null) return
    let live = true
    void window.anticode
      .previewFile(target.kind === 'artifact' ? target.sessionId : null, target.path)
      .then((result) => {
        if (live) setPreview(result)
      })
      .catch((error: Error) => {
        if (live) setFailure(error.message)
      })
    return () => {
      live = false
    }
  }, [target])

  // Chromium's own PDF viewer draws the file; it reads it from a blob URL.
  useEffect(() => {
    if (preview?.kind !== 'pdf' || preview.data === undefined) {
      setPdfUrl(null)
      return
    }
    const binary = atob(preview.data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
    setPdfUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [preview])

  useEffect(() => {
    if (target === null) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [target, close])

  if (target === null) return <></>
  const name = nameOf(target)
  const pages = preview?.kind === 'pages' ? preview.pages : []
  const page = pages[pageIndex]

  function openInApp(): void {
    if (target === null) return
    const opened =
      target.kind === 'artifact'
        ? window.anticode.openArtifact(target.sessionId, target.path)
        : window.anticode.openAttachment(target.path)
    void opened.then((error) => setFailure(error)).catch((error: Error) => setFailure(error.message))
  }

  function download(): void {
    if (target?.kind !== 'artifact') return
    void window.anticode
      .saveArtifact(target.sessionId, target.path)
      .then((destination) => {
        if (destination !== null) setSaved(destination)
      })
      .catch((error: Error) => setFailure(error.message))
  }

  return (
    <div
      role="dialog"
      aria-label={name}
      data-file-viewer
      className="fixed inset-x-0 top-12 bottom-0 z-[25] flex flex-col border-t border-line bg-bg"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-soft pr-2 pl-4">
        <span className="flex h-6 shrink-0 items-center rounded-md bg-raised px-1.5 text-[9px] font-semibold tracking-wide text-dim">
          {tagOf(name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text" title={target.path}>
          {name}
        </span>
        {saved !== null && <span className="max-w-72 truncate text-[11.5px] text-add">Saved to {saved}</span>}
        <button
          type="button"
          onClick={openInApp}
          className="glass-ghost shrink-0 rounded-md px-2 py-1 text-[12.5px] text-dim hover:text-brand"
        >
          Open in app
        </button>
        {target.kind === 'artifact' && (
          <>
            <button
              type="button"
              onClick={() => {
                void window.anticode.revealArtifact(target.sessionId, target.path).then((failure) => {
                  if (failure !== null) setFailure(failure)
                })
              }}
              className="glass-ghost shrink-0 rounded-md px-2 py-1 text-[12.5px] text-dim hover:text-brand"
            >
              Reveal
            </button>
            <button
              type="button"
              onClick={download}
              className="glass-ghost shrink-0 rounded-md px-2 py-1 text-[12.5px] text-dim hover:text-brand"
            >
              Download
            </button>
          </>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Close preview"
          className="glass-ghost flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim hover:text-brand"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>

      {pages.length > 1 && (
        <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-soft px-2">
          {pages.map((entry, index) => (
            <button
              key={`${entry.label}-${index}`}
              type="button"
              onClick={() => setPageIndex(index)}
              className={`glass-ghost h-7 max-w-48 shrink-0 truncate rounded-md px-2.5 text-[12px] hover:text-brand ${
                index === pageIndex ? 'text-text' : 'text-dim'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {page?.note !== undefined && (
        <div className="shrink-0 border-b border-line-soft px-4 py-1.5 text-[11.5px] text-faint">{page.note}</div>
      )}
      {failure !== null && <div className="shrink-0 bg-raised px-4 py-2 text-[12px] text-del">{failure}</div>}

      <div className="relative min-h-0 flex-1">
        {preview === null && failure === null && (
          <div className="flex h-full items-center justify-center text-[13px] text-dim">Opening…</div>
        )}
        {page !== undefined && (
          <iframe
            key={`${target.path}-${pageIndex}`}
            title={page.label}
            sandbox=""
            srcDoc={page.html}
            className="block h-full w-full border-0"
          />
        )}
        {preview?.kind === 'image' && preview.data !== undefined && (
          <div className="flex h-full items-center justify-center overflow-auto p-6">
            <img
              src={`data:${preview.mime};base64,${preview.data}`}
              alt={preview.name}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
        {preview?.kind === 'pdf' && pdfUrl !== null && (
          <iframe title={preview.name} src={pdfUrl} className="block h-full w-full border-0" />
        )}
        {preview?.kind === 'none' && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <span className="max-w-md text-[13px] text-dim">{preview.reason}</span>
            <button
              type="button"
              onClick={openInApp}
              className="rounded-md px-2 py-1 text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
            >
              Open in app
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
