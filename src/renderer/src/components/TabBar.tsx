import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import { Badge } from './Badge'

interface TabBarProps {
  onHome: () => void
  onNewTab: () => void
  homeActive: boolean
}

function GridIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor" aria-hidden>
      <rect x="1" y="1" width="5" height="5" rx="1.2" />
      <rect x="9" y="1" width="5" height="5" rx="1.2" />
      <rect x="1" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </svg>
  )
}

export function TabBar({ onHome, onNewTab, homeActive }: TabBarProps): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const projects = useSessionStore((state) => state.projects)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const selectSession = useSessionStore((state) => state.selectSession)
  const closeSession = useSessionStore((state) => state.closeSession)

  function badgeName(session: { mode: string; projectRoot: string | null }): string {
    if (session.mode === 'chat') return 'antichat'
    return projects.find((project) => project.root === session.projectRoot)?.name ?? 'sesi'
  }

  return (
    <header className="region-drag flex h-11 shrink-0 items-center gap-1 pr-3 pl-20">
      <button
        type="button"
        onClick={onHome}
        title="Semua project"
        className={`region-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
          homeActive ? 'bg-hover text-text' : 'text-faint hover:bg-raised hover:text-dim'
        }`}
      >
        <GridIcon />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {sessions.map((session) => {
          const isActive = !homeActive && session.id === activeSessionId
          return (
            <div
              key={session.id}
              className={`region-no-drag group flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 transition-colors ${
                isActive ? 'bg-hover' : 'hover:bg-raised'
              }`}
            >
              <Badge name={badgeName(session)} />
              <button
                type="button"
                onClick={() => selectSession(session.id)}
                className={`min-w-0 max-w-52 truncate text-[13px] ${
                  isActive ? 'text-text' : 'text-dim'
                }`}
              >
                {session.title}
              </button>
              <button
                type="button"
                onClick={() => {
                  closeSession(session.id)
                  void window.anticode.closeSession(session.id)
                }}
                aria-label="Tutup tab"
                className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
              >
                ×
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={onNewTab}
          aria-label="Tab baru"
          className="region-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-text"
        >
          +
        </button>
      </div>
    </header>
  )
}
