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
  onDelete
}: {
  session: Session
  onSelect: (id: string) => void
  onDelete?: (id: string) => void
}): JSX.Element {
  return (
    <div className="group relative flex w-full items-start">
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-raised"
      >
        <span className="mt-0.5">
          <Badge label={badgeLabel(session)} colour={session.colour} size="md" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] text-text">{session.title}</div>
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
      {onDelete !== undefined && (
        <button
          type="button"
          aria-label="Delete session"
          onClick={() => onDelete(session.id)}
          className="absolute top-2.5 right-2 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-del"
        >
          ×
        </button>
      )}
    </div>
  )
}
