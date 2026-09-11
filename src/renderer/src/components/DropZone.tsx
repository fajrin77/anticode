import { useEffect, useRef, useState } from 'react'
import type { DragEvent, JSX, ReactNode } from 'react'
import type { AttachmentInfo } from '@shared/ipc'
import { useSessionStore } from '../store/session'

/** Spread-based encoding blows the call stack on megabyte images. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

/**
 * The whole session is a place to drop a file — the transcript, the empty
 * space around it, the composer — not only the text box. Whatever lands is
 * staged on this session's draft, exactly as the + button would stage it.
 */
export function DropZone({ sessionId, children }: { sessionId: string; children: ReactNode }): JSX.Element {
  // dragenter/dragleave fire for every child crossed; counting them is what
  // keeps the sheet from flickering as the cursor moves over the transcript.
  const depth = useRef(0)
  const [over, setOver] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (error === null) return
    const timer = window.setTimeout(() => setError(null), 4000)
    return () => window.clearTimeout(timer)
  }, [error])

  async function stage(files: File[]): Promise<void> {
    // A file from Finder has a path; one dragged out of a browser or another
    // app may not, and then its bytes travel instead.
    const withPath = files.map((file) => ({ file, path: window.anticode.pathForFile(file) }))
    const byPath = withPath.filter((entry) => entry.path !== '').map((entry) => entry.path)
    const byBytes = withPath.filter((entry) => entry.path === '').map((entry) => entry.file)
    const batches: Promise<AttachmentInfo[]>[] = []
    if (byPath.length > 0) batches.push(window.anticode.addAttachments(byPath))
    for (const file of byBytes) {
      batches.push(
        file.arrayBuffer().then((buffer) =>
          window.anticode.addAttachmentData(file.name === '' ? `dropped-${Date.now()}` : file.name, toBase64(buffer))
        )
      )
    }
    try {
      const added = (await Promise.all(batches)).flat()
      const store = useSessionStore.getState()
      const previous = store.drafts[sessionId]?.attachments ?? []
      store.updateDraft(sessionId, { attachments: [...previous, ...added] })
      document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
    } catch (failure) {
      setError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  return (
    <div
      data-drop-zone
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) void stage(files)
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border border-dashed border-brand bg-bg/80">
          <span className="text-[14px] text-brand">Drop to attach</span>
        </div>
      )}
      {error !== null && (
        <div className="absolute inset-x-0 bottom-2 z-30 mx-auto w-fit rounded-lg bg-raised px-3 py-1.5 text-[12.5px] text-del">
          {error}
        </div>
      )}
    </div>
  )
}
