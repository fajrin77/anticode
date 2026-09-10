import { useState } from 'react'
import type { JSX } from 'react'
import type { MessagePart } from '../store/session'
import { usePreviewStore } from '../store/preview'

/** Files a person opens rather than reads as code — worth offering to save. */
const DOCUMENT_EXTENSIONS = ['.pdf', '.xlsx', '.xlsm', '.docx', '.csv', '.pptx', '.zip']

function extensionOf(target: string): string {
  const dot = target.lastIndexOf('.')
  return dot === -1 ? '' : target.slice(dot).toLowerCase()
}

/**
 * The documents a run produced, read back from its own tool calls. Only
 * successful writes count, and only of the kinds someone would want to keep —
 * source files stay where they belong, in the diff. antichat has no project
 * to keep them in, so there every file it writes is one to hand back.
 */
export function documentsProduced(parts: MessagePart[], everyFile = false): string[] {
  const paths: string[] = []
  for (const part of parts) {
    if (part.kind !== 'tool' || part.status !== 'ok') continue
    if (!/^(write|create|fill|add|format)_/.test(part.name)) continue
    if (part.input === null || typeof part.input !== 'object') continue
    const input = part.input as Record<string, unknown>
    const target = typeof input.output_path === 'string' ? input.output_path : input.path
    if (typeof target !== 'string') continue
    if (!everyFile && !DOCUMENT_EXTENSIONS.includes(extensionOf(target))) continue
    if (!paths.includes(target)) paths.push(target)
  }
  return paths
}

export function Artifacts({
  sessionId,
  paths
}: {
  sessionId: string
  paths: string[]
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<Record<string, string>>({})
  const preview = usePreviewStore((state) => state.open)

  return (
    <div className="my-3 flex flex-col gap-1.5">
      {paths.map((target) => (
        <div
          key={target}
          className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2"
        >
          {/* The file itself is the button: it opens here, in the session. */}
          <button
            type="button"
            onClick={() => preview({ kind: 'artifact', sessionId, path: target })}
            title="Preview"
            className="group flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            <span className="flex h-7 w-9 shrink-0 items-center justify-center rounded-md bg-raised text-[9px] font-semibold tracking-wide text-dim transition-colors group-hover:text-brand">
              {extensionOf(target).slice(1, 5).toUpperCase() || 'FILE'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12.5px] text-text transition-colors group-hover:text-brand">
                {target}
              </span>
              {saved[target] !== undefined && (
                <span className="block truncate text-[11px] text-add">Saved to {saved[target]}</span>
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              void window.anticode
                .saveArtifact(sessionId, target)
                .then((destination) => {
                  setError(null)
                  if (destination !== null) setSaved((current) => ({ ...current, [target]: destination }))
                })
                .catch((failure: Error) => setError(failure.message))
            }}
            className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
          >
            Download
          </button>
        </div>
      ))}
      {error !== null && <div className="px-1 text-[12px] text-del">{error}</div>}
    </div>
  )
}
