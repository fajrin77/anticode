import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { Badge } from './Badge'

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/** Per-session usage only — an icon that unfolds the totals on demand. */
function UsageButton({ session }: { session: Session }): JSX.Element {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onOutside(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const totalTokens = session.inputTokens + session.outputTokens

  return (
    <div className="region-no-drag relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Session usage"
        className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          open ? 'bg-raised text-brand' : 'text-dim hover:bg-raised hover:text-brand'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <rect x="2" y="9" width="3" height="5" rx="1" />
          <rect x="6.5" y="5" width="3" height="9" rx="1" />
          <rect x="11" y="2" width="3" height="12" rx="1" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 z-20 mt-1 w-96 rounded-xl border border-line bg-raised p-4 shadow-2xl">
          <div className="mb-1 text-[13px] text-text">Session usage</div>
          <div className="mb-2 truncate text-[11.5px] text-faint">{session.title}</div>
          <div className="grid grid-cols-2 gap-x-6 border-t border-line-soft pt-2">
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-[12px] text-faint">Input tokens</span>
              <span className="text-[12.5px] text-text">{formatNumber(session.inputTokens)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-[12px] text-faint">Output tokens</span>
              <span className="text-[12.5px] text-text">{formatNumber(session.outputTokens)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-[12px] text-faint">Total tokens</span>
              <span className="text-[12.5px] text-text">{formatNumber(totalTokens)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-1.5">
              <span className="text-[12px] text-faint">Messages</span>
              <span className="text-[12.5px] text-text">{formatNumber(session.messages.length)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface TabBarProps {
  onDashboard: () => void
  onOpenSettings: () => void
  onNewTab: () => void
  onSelectSession: (id: string) => void
  /** True while the dashboard view is on screen — lights the grid icon lime. */
  dashboardActive: boolean
  /** True while Settings is on screen — lights the gear the same way. */
  settingsActive: boolean
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

export function TabBar({
  onDashboard,
  onOpenSettings,
  onNewTab,
  onSelectSession,
  dashboardActive,
  settingsActive
}: TabBarProps): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const closeSession = useSessionStore((state) => state.closeSession)
  const deleteSession = useSessionStore((state) => state.deleteSession)
  const activeRuns = useSessionStore((state) => state.activeRuns)
  const mirrorRuns = useSessionStore((state) => state.mirrorRuns)
  const activeSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId && !session.closed)
  )

  // Closing a tab archives the session (still editable from the dashboard)
  // and stops its run — otherwise the agent keeps burning tokens with no way
  // to stop it. The main-process session stays alive so history survives.
  // A draft that was never prompted cannot be reopened from the dashboard, so
  // closing its tab deletes it outright — everywhere, including the phone.
  function close(sessionId: string): void {
    for (const run of Object.values(activeRuns)) if (run.sessionId === sessionId) void window.anticode.cancelRun(run.runId)
    for (const [runId, run] of Object.entries(mirrorRuns)) if (run.sessionId === sessionId) void window.anticode.cancelRun(runId)
    const session = sessions.find((entry) => entry.id === sessionId)
    if (session !== undefined && session.messages.length === 0) {
      void window.anticode.closeSession(sessionId)
      deleteSession(sessionId)
      return
    }
    closeSession(sessionId)
  }

  function badgeName(session: { mode: string; projectRoot: string | null }): string {
    if (session.mode === 'chat') return 'antichat'
    if (session.projectRoot !== null) {
      const parts = session.projectRoot.split(/[\\/]/).filter((part) => part !== '')
      return parts.at(-1) ?? 'session'
    }
    return 'session'
  }

  return (
    <header className="region-drag flex h-12 shrink-0 items-center gap-1.5 pr-3 pl-20">
      <button
        type="button"
        onClick={onDashboard}
        title="Dashboard"
        aria-pressed={dashboardActive}
        className={`region-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-raised hover:text-brand ${
          dashboardActive ? 'text-brand' : 'text-faint'
        }`}
      >
        <GridIcon />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {sessions.filter((session) => !session.closed).map((session) => {
          const isActive = session.id === activeSessionId
          const running =
            Object.values(activeRuns).some((run) => run.sessionId === session.id) ||
            Object.values(mirrorRuns).some((entry) => entry.sessionId === session.id)
          return (
            <div
              key={session.id}
              className={`region-no-drag group flex h-9 min-w-0 shrink items-center gap-2 rounded-lg px-3 transition-colors ${
                isActive ? 'bg-hover' : 'hover:bg-raised'
              }`}
            >
              <Badge
                label={badgeName(session)}
                colour={session.colour}
                spinning={running}
              />
              <button
                type="button"
                onClick={() => onSelectSession(session.id)}
                title={session.title}
                className={`min-w-0 max-w-52 truncate text-[14px] ${
                  isActive ? 'text-text' : 'text-dim'
                }`}
              >
                {session.title}
              </button>
              <button
                type="button"
                onClick={() => close(session.id)}
                aria-label="Close tab"
                className="shrink-0 text-faint opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-brand focus-visible:opacity-100"
              >
                ×
              </button>
            </div>
          )
        })}

        <button
          type="button"
          onClick={onNewTab}
          aria-label="New tab"
          className="region-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-brand"
        >
          +
        </button>
      </div>

      {/* Usage and settings sit on the same row as the session tabs — outside
          the scrolling strip, whose overflow would clip the usage popover. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {activeSession !== undefined && <UsageButton session={activeSession} />}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          aria-pressed={settingsActive}
          className={`region-no-drag flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-raised hover:text-brand ${
            settingsActive ? 'text-brand' : 'text-dim'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 4.5h5.6M11.4 4.5H14M2 11.5h1.6M7.4 11.5H14" strokeLinecap="round" />
            <circle cx="9.5" cy="4.5" r="1.9" />
            <circle cx="5.4" cy="11.5" r="1.9" />
          </svg>
        </button>
      </div>
    </header>
  )
}
