import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { MessagePart } from '../store/session'
import { usePreviewStore } from '../store/preview'

/** Files a person opens rather than reads as code, worth offering to save. */
const DOCUMENT_EXTENSIONS = [
  '.pdf', '.xlsx', '.xlsm', '.docx', '.csv', '.pptx', '.zip',
  '.png', '.jpg', '.jpeg', '.webp', '.gif'
]

function extensionOf(target: string): string {
  const dot = target.lastIndexOf('.')
  return dot === -1 ? '' : target.slice(dot).toLowerCase()
}

/**
 * The documents a run produced, read back from its own tool calls. Only
 * successful writes count, and only of the kinds someone would want to keep,
 * source files stay where they belong, in the diff. antichat has no project
 * to keep them in, so there every file it writes is one to hand back. A file
 * the agent passed to `share_file` always counts: it was handed over on
 * purpose, whatever its kind.
 */
export function documentsProduced(parts: MessagePart[], everyFile = false): string[] {
  const paths: string[] = []
  for (const part of parts) {
    if (part.kind !== 'tool' || part.status !== 'ok') continue
    const shared = part.name === 'share_file'
    if (!shared && !/^(write|create|fill|add|format|generate)_/.test(part.name)) continue
    if (part.input === null || typeof part.input !== 'object') continue
    const input = part.input as Record<string, unknown>
    const target = typeof input.output_path === 'string' ? input.output_path : input.path
    if (typeof target !== 'string') continue
    if (!shared && !everyFile && !DOCUMENT_EXTENSIONS.includes(extensionOf(target))) continue
    if (!paths.includes(target)) paths.push(target)
  }
  return paths
}

const KIND_LABELS: Record<string, string> = {
  '.xlsx': 'Excel', '.xlsm': 'Excel', '.csv': 'CSV', '.docx': 'Word', '.pdf': 'PDF',
  '.pptx': 'PowerPoint', '.zip': 'Archive', '.png': 'Image', '.jpg': 'Image',
  '.jpeg': 'Image', '.webp': 'Image', '.gif': 'Image'
}

function baseName(target: string): string {
  return target.split(/[\\/]/).filter(Boolean).at(-1) ?? target
}

/**
 * One produced file, laid out like an attachment card: type icon, file name,
 * what kind of file it is, and an "Open in" menu with the default app, Finder
 * and a saved copy. Clicking the name still previews it in the session.
 */
export function Artifacts({
  sessionId,
  paths
}: {
  sessionId: string
  paths: string[]
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const savingRef = useRef(new Set<string>())
  const [saved, setSaved] = useState<Record<string, string>>({})
  const preview = usePreviewStore((state) => state.open)

  // Any click outside the open menu, or Escape, closes it.
  useEffect(() => {
    if (menu === null) return
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && (event.target as HTMLElement | null)?.closest('[data-artifact-menu]')) return
      setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [menu])

  const report = (job: Promise<string | null>): void => {
    void job.then((failure) => setError(failure)).catch((failure: Error) => setError(failure.message))
  }

  const save = (target: string): void => {
    if (savingRef.current.has(target)) return
    savingRef.current.add(target)
    setError(null)
    void window.anticode
      .saveArtifact(sessionId, target)
      .then((destination) => {
        if (destination !== null) setSaved((current) => ({ ...current, [target]: destination }))
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => savingRef.current.delete(target))
  }

  return (
    <div className="my-3 flex flex-col overflow-visible rounded-xl border border-line bg-surface">
      {paths.map((target, index) => {
        const extension = extensionOf(target)
        return (
          <div
            key={target}
            className={`relative flex items-center gap-3 px-3 py-2.5 ${index > 0 ? 'border-t border-line-soft' : ''}`}
          >
            <button
              type="button"
              onClick={() => preview({ kind: 'artifact', sessionId, path: target })}
              title={target}
              className="group flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-[9px] font-semibold tracking-wide text-dim transition-colors group-hover:text-brand">
                {extension.slice(1, 5).toUpperCase() || 'FILE'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text transition-colors group-hover:text-brand">
                  {baseName(target)}
                </span>
                <span className="block truncate text-[11.5px] text-faint">
                  {saved[target] !== undefined ? `Saved to ${saved[target]}` : KIND_LABELS[extension] ?? 'File'}
                </span>
              </span>
            </button>
            <div data-artifact-menu className="relative shrink-0">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menu === target}
                onClick={() => setMenu(menu === target ? null : target)}
                className="flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-brand"
              >
                Open in
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <path d="M2 3.5 5 6.5 8 3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {menu === target && (
                <div
                  role="menu"
                  className="glass-surface absolute top-full right-0 z-20 mt-1 w-52 overflow-hidden rounded-lg border border-line py-1 shadow-2xl"
                >
                  {[
                    { label: 'Default app', run: () => report(window.anticode.openArtifact(sessionId, target)) },
                    { label: 'Show in Finder', run: () => report(window.anticode.revealArtifact(sessionId, target)) },
                    { label: 'Download a copy', run: () => save(target) }
                  ].map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null)
                        item.run()
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[12.5px] text-dim transition-colors hover:bg-hover hover:text-text"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
      {error !== null && <div role="alert" className="border-t border-line-soft px-3 py-2 text-[12px] text-del">{error}</div>}
    </div>
  )
}
