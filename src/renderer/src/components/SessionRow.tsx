import { useState } from 'react'
import type { JSX } from 'react'
import type { Session } from '../store/session'
import { Badge } from './Badge'

function folderName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part !== '')
  return parts.at(-1) ?? root
}

export function badgeLabel(session: Session): string {
  if (session.mode === 'chat') return 'antichat'
  return session.projectRoot !== null ? folderName(session.projectRoot) : 'session'
}

export function SessionRow({
  session,
  onSelect,
  onDelete,
  onDuplicate,
  spinning = false
}: {
  session: Session
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
  onDuplicate?: (id: string) => void
  spinning?: boolean
}): JSX.Element {
  // Deleting a session also deletes its checkpoints and chat files, there is
  // no undo, so the first click only arms the button, the second confirms.
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="group relative flex w-full items-start">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-raised"
      >
        <span className="mt-0.5">
          <Badge label={badgeLabel(session)} colour={session.colour} size="md" spinning={spinning} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] text-text transition-colors group-hover:text-brand">
            {session.title}
          </div>
          {/* Code sessions always name the folder they are bound to. */}
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-faint">
            {session.mode === 'chat' ? (
              <span>antichat</span>
            ) : (
              <>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
                </svg>
                <span className="truncate">
                  {session.projectRoot !== null ? folderName(session.projectRoot) : 'no folder'}
                </span>
              </>
            )}
          </div>
        </div>
      </button>
      {onDuplicate !== undefined && (
        <button
          type="button"
          aria-label="Duplicate session"
          onClick={() => onDuplicate(session.id)}
          className="absolute top-2 right-10 text-faint opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-brand"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H4.5A1.5 1.5 0 0 0 3 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
          </svg>
        </button>
      )}
      {onDelete !== undefined && (
        <button
          type="button"
          aria-label={confirming ? `Confirm deleting this session` : 'Delete session'}
          title={confirming ? 'Click again, deleting also removes its checkpoints and files' : 'Delete session'}
          onClick={() => (confirming ? onDelete(session.id) : setConfirming(true))}
          onBlur={() => setConfirming(false)}
          className={`absolute top-2.5 right-2 text-[13px] leading-none opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:text-del ${
            confirming ? 'font-medium text-del' : 'text-faint'
          } transition-colors ${confirming ? '' : 'hover:text-del'}`}
        >
          {confirming ? 'Delete?' : '×'}
        </button>
      )}
    </div>
  )
}
