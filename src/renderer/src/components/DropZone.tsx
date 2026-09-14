import { useRef, useState } from 'react'
import type { DragEvent, JSX, ReactNode } from 'react'
import { stageDraftAttachments, fileAttachmentJob } from '../draftAttachments'

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
  async function stage(files: File[]): Promise<void> {
    await stageDraftAttachments(sessionId, files.map(fileAttachmentJob))
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

    </div>
  )
}
