import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { useWebSession } from '../store/web'
import { Badge } from './Badge'
import { HISTORY_TOKEN_BUDGET } from '@shared/ipc'
import { formatUsd } from '../money'

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/** Per-session usage only — an icon that unfolds the totals on demand. */
function UsageButton({ session }: { session: Session }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [compacted, setCompacted] = useState<string | null>(null)
  const setContextTokens = useSessionStore((state) => state.setContextTokens)
  const busy = useSessionStore((state) =>
    Object.values(state.activeRuns).some((run) => run.sessionId === session.id) ||
    Object.values(state.mirrorRuns).some((run) => run.sessionId === session.id)
  )

  function compact(): void {
    setCompacting(true)
    setCompacted(null)
    void window.anticode
      .compactSession(session.id)
      .then(({ before, after }) => {
        setContextTokens(session.id, after)
        setCompacted(
          after < before
            ? `${formatNumber(before)} → ${formatNumber(after)} tokens`
            : 'Nothing earlier to compact'
        )
      })
      .catch((error: Error) => setCompacted(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .finally(() => setCompacting(false))
  }
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
  const contextPercent = Math.min(100, Math.round((session.lastInputTokens / HISTORY_TOKEN_BUDGET) * 100))

  return (
    <div className="region-no-drag relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Session usage"
        className={`glass-ghost flex h-7 w-7 items-center justify-center rounded-md hover:text-brand ${
          open ? 'text-brand' : 'text-dim'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <rect x="2" y="9" width="3" height="5" rx="1" />
          <rect x="6.5" y="5" width="3" height="9" rx="1" />
          <rect x="11" y="2" width="3" height="12" rx="1" />
        </svg>
      </button>

      {open && (
        <div className="menu-glass absolute top-full right-0 z-20 mt-1 w-96 rounded-xl border p-4">
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
            <div
              className="col-span-2 flex items-baseline justify-between gap-4 py-1.5"
              title={session.costPartial === true ? 'Some requests used a model with no price — set one in Settings → Pricing' : 'From the prices in Settings → Pricing'}
            >
              <span className="text-[12px] text-faint">Estimated cost</span>
              <span className="text-[12.5px] tabular-nums text-text">
                {session.costPartial === true ? '≥ ' : ''}
                {formatUsd(session.costUsd ?? 0)}
              </span>
            </div>
          </div>
          <div className="mt-2 border-t border-line-soft pt-3">
            <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
              <span className="text-faint">Current context</span>
              <span className={contextPercent >= 85 ? 'text-del' : 'text-dim'}>{contextPercent}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-raised">
              <div
                className={`h-full rounded-full transition-[width] ${contextPercent >= 85 ? 'bg-del' : 'bg-brand'}`}
                style={{ width: `${contextPercent}%` }}
              />
            </div>
            <div className="mt-1.5 text-[10.5px] text-faint">
              Latest request against {formatNumber(HISTORY_TOKEN_BUDGET)} token replay budget
            </div>
          </div>
          <button
            type="button"
            onClick={compact}
            disabled={compacting || busy}
            title={busy ? 'Pause this session to compact it' : 'Fold earlier turns into a memory the model writes'}
            className="mt-3 flex w-full items-baseline justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] text-dim transition-colors enabled:hover:bg-raised enabled:hover:text-brand disabled:opacity-50"
          >
            <span>{compacting ? 'Compacting…' : 'Compact context'}</span>
            <span className={`truncate text-[11px] tabular-nums text-faint ${compacted === null ? 'invisible' : ''}`}>
              {compacted ?? '—'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void window.anticode.exportSession(session.id)}
            className="w-full rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] text-dim transition-colors hover:bg-raised hover:text-brand"
          >
            Export transcript…
          </button>
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

/**
 * Shows and hides the browser pane for the session on screen. Hiding is sticky
 * for the rest of that session — a page the agent opens later updates the pane
 * quietly instead of pushing it back on screen — so this button is the only
 * way back. A session with no page at all gets a blank pane with an address
 * bar, which is the other half of "anticode has a browser of its own".
 */
function BrowserButton({ sessionId }: { sessionId: string }): JSX.Element {
  const entry = useWebSession(sessionId)
  const shown = entry !== undefined && !entry.hidden

  return (
    <button
      type="button"
      onClick={() => void window.anticode.setWebVisible(sessionId, !shown)}
      title={shown ? 'Hide browser' : 'Show browser'}
      aria-pressed={shown}
      data-browser-toggle
      className={`glass-ghost region-no-drag flex h-7 w-7 items-center justify-center rounded-md hover:text-brand ${
        shown ? 'text-brand' : 'text-dim'
      }`}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
        <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2" />
        <path d="M1.7 6h12.6" />
        <path d="M4.3 4.35h.01M6.2 4.35h.01" strokeLinecap="round" strokeWidth="1.6" />
      </svg>
    </button>
  )
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
  // The stop is a pause, the same one the pause button makes: the work it
  // cut short can be resumed from the reopened tab or from the phone.
  // A draft that was never prompted cannot be reopened from the dashboard, so
  // closing its tab deletes it outright — everywhere, including the phone.
  function close(sessionId: string): void {
    void window.anticode.pauseSession(sessionId)
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
    <header className="desktop-header-glass region-drag flex h-12 shrink-0 items-center gap-1.5 pr-3 pl-20">
      <div className="header-fade" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
      <button
        type="button"
        onClick={onDashboard}
        title="Dashboard"
        aria-pressed={dashboardActive}
        className={`glass-ghost region-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:text-brand ${
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
              // No box at rest, the selected tab included: it is told apart by
              // its brighter title, and the box shows only under the cursor.
              className="region-no-drag group glass-ghost flex h-9 min-w-0 shrink items-center gap-2 rounded-lg px-3"
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
                className={`min-w-0 max-w-52 truncate text-[14px] transition-colors group-hover:text-brand ${
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
          className="glass-ghost region-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-faint hover:text-brand"
        >
          +
        </button>
      </div>

      {/* Usage and settings sit on the same row as the session tabs — outside
          the scrolling strip, whose overflow would clip the usage popover. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {activeSession !== undefined && <BrowserButton sessionId={activeSession.id} />}
        {activeSession !== undefined && <UsageButton session={activeSession} />}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          aria-pressed={settingsActive}
          className={`glass-ghost region-no-drag flex h-7 w-7 items-center justify-center rounded-md hover:text-brand ${
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
