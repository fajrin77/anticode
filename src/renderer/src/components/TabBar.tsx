import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { useWebSession } from '../store/web'
import { Badge } from './Badge'
import { contextWindowFor, historyBudgetFor } from '@shared/ipc'
import { formatUsd } from '../money'
import { InstructionsField } from './InstructionsField'

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/** Per-session usage only, an icon that unfolds the totals on demand. */
function UsageButton({ session }: { session: Session }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const [editingInstructions, setEditingInstructions] = useState(false)
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
  // The same ceiling the loop compacts against, a 1M-window model is not
  // "85% full" at 85k tokens. `budget` is the replay ceiling (window minus
  // reply headroom); `window` is the vendor's documented size, shown so the
  // number reads as "used of total" instead of a mystery denominator. Both
  // come from the main process, which also knows a window a gateway published
  // for this exact id rather than only the built-in family table.
  const model = session.model ?? ''
  const fallbackWindow = contextWindowFor(model)
  const [sizes, setSizes] = useState<{ window: number; budget: number } | null>(null)
  useEffect(() => {
    let active = true
    void window.anticode
      .contextBudget(model)
      .then((next) => {
        if (active) setSizes(next)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [model])
  const modelWindow = sizes?.window ?? fallbackWindow
  const budget = sizes?.budget ?? historyBudgetFor(model, fallbackWindow)
  const used = session.lastInputTokens
  const contextPercent = Math.min(100, Math.round((used / budget) * 100))
  const remaining = Math.max(0, budget - used)

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
              title={session.costPartial === true ? 'Some requests used a model with no price. Set one in Settings → Pricing' : 'From the prices in Settings → Pricing'}
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
              <span className={`tabular-nums ${contextPercent >= 85 ? 'text-del' : contextPercent >= 70 ? 'text-text' : 'text-dim'}`}>
                {formatNumber(used)} / {formatNumber(budget)} · {contextPercent}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-raised">
              <div
                className={`h-full rounded-full transition-[width] ${contextPercent >= 85 ? 'bg-del' : 'bg-brand'}`}
                style={{ width: `${contextPercent}%` }}
              />
            </div>
            <div className="mt-1.5 text-[10.5px] text-faint">
              {contextPercent >= 85
                ? `Nearly full — ${formatNumber(remaining)} left. Compact now or start a fresh session.`
                : contextPercent >= 70
                  ? `${formatNumber(remaining)} tokens left before auto-compaction (window ${formatNumber(modelWindow)}).`
                  : `Latest request against ${formatNumber(budget)} token budget · window ${formatNumber(modelWindow)}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditingInstructions((value) => !value)}
            aria-expanded={editingInstructions}
            className="mt-3 flex w-full items-baseline justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] text-dim transition-colors hover:bg-raised hover:text-brand"
          >
            <span>Session instructions</span>
            <span className={`text-[11px] text-faint ${session.instructions === undefined ? 'invisible' : ''}`}>set</span>
          </button>
          {editingInstructions && (
            <div className="px-2 pb-2">
              <InstructionsField
                value={session.instructions ?? ''}
                rows={4}
                placeholder="Only for this session, e.g. focus on the payment module; reply briefly."
                onSave={(text) =>
                  window.anticode
                    .setSessionInstructions(session.id, text)
                    .then((spec) => useSessionStore.getState().addExternalSession(spec))
                }
              />
            </div>
          )}
          <button
            type="button"
            onClick={compact}
            disabled={compacting || busy}
            title={busy ? 'Pause this session to compact it' : 'Fold earlier turns into a memory the model writes'}
            className="flex w-full items-baseline justify-between gap-3 rounded-md border border-transparent px-2 py-1.5 text-left text-[12px] text-dim transition-colors enabled:hover:bg-raised enabled:hover:text-brand disabled:opacity-50"
          >
            <span>{compacting ? 'Compacting…' : 'Compact context'}</span>
            <span className={`truncate text-[11px] tabular-nums text-faint ${compacted === null ? 'invisible' : ''}`}>
              {compacted ?? '·'}
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
  onOpenSchedule: () => void
  onNewTab: () => void
  onSelectSession: (id: string) => void
  /** True while the dashboard view is on screen, lights the grid icon lime. */
  dashboardActive: boolean
  /** True while Settings is on screen, lights the gear the same way. */
  settingsActive: boolean
  /** True while Schedule is on screen, lights the clock the same way. */
  scheduleActive: boolean
}

/**
 * Shows and hides the browser pane for the session on screen. Hiding is sticky
 * for the rest of that session, a page the agent opens later updates the pane
 * quietly instead of pushing it back on screen, so this button is the only
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
  onOpenSchedule,
  onNewTab,
  onSelectSession,
  dashboardActive,
  settingsActive,
  scheduleActive
}: TabBarProps): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const closeSession = useSessionStore((state) => state.closeSession)
  const deleteSession = useSessionStore((state) => state.deleteSession)
  const moveSession = useSessionStore((state) => state.moveSession)
  const moveSessionTo = useSessionStore((state) => state.moveSessionTo)
  const activeRuns = useSessionStore((state) => state.activeRuns)
  const mirrorRuns = useSessionStore((state) => state.mirrorRuns)
  const activeSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId && !session.closed)
  )
  // Closing a tab archives the session (still editable from the dashboard)
  // and stops its run, otherwise the agent keeps burning tokens with no way
  // to stop it. The main-process session stays alive so history survives.
  // The stop is a pause, the same one the pause button makes: the work it
  // cut short can be resumed from the reopened tab or from the phone.
  // A draft that was never prompted cannot be reopened from the dashboard, so
  // closing its tab deletes it outright, everywhere, including the phone.
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

  // Dragging a tab reorders the strip. The pointer listeners live on the window
  // for the length of one drag: the tab itself is moved around inside the
  // strip, and pointer capture would not survive that.
  const strip = useRef<HTMLDivElement>(null)
  // Crowded: the tabs are narrow enough that a hover-revealed × would cover
  // most of what is left to click.
  const [crowded, setCrowded] = useState(false)
  const openCount = sessions.filter((session) => !session.closed).length
  // Fixed threshold instead of width measurement: through nine tabs every tab
  // keeps its title (the strip scrolls when narrow); past nine the whole bar
  // turns into icons at once, so no tab is left title-less beside them.
  const iconOnly = openCount > 9
  // Share the available strip in icon mode instead of leaving an empty tail.
  // Keep a usable minimum and scroll rather than crushing the badges.
  useEffect(() => {
    const host = strip.current
    if (host === null) return
    const measure = (): void => {
      setCrowded(openCount > 0 && host.clientWidth / openCount < 128)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [openCount])
  useEffect(() => {
    const host = strip.current
    if (!host) return
    const revealActive = (): void => {
      const active = host.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!active) return
      const bounds = host.getBoundingClientRect()
      const tab = active.getBoundingClientRect()
      if (tab.right > bounds.right) host.scrollLeft += tab.right - bounds.right
      else if (tab.left < bounds.left) host.scrollLeft -= bounds.left - tab.left
    }
    revealActive()
    const observer = new ResizeObserver(revealActive)
    observer.observe(host)
    return () => observer.disconnect()
  }, [activeSessionId, openCount, iconOnly])
  const drag = useRef<number | null>(null)
  const dragged = useRef(false)

  /** Where a dragged tab would land: the dragged tab itself is skipped, so the
   *  strip never chases the cursor it is already under. */
  function dropIndex(host: HTMLElement, clientX: number, draggedId: string): number {
    let index = 0
    for (const tab of host.querySelectorAll<HTMLElement>('[data-tab-id]')) {
      if (tab.dataset.tabId === draggedId) continue
      const box = tab.getBoundingClientRect()
      if (clientX > box.left + box.width / 2) index++
    }
    return index
  }

  function startDrag(sessionId: string, event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const startX = event.clientX
    let moved = false
    drag.current = event.pointerId
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== drag.current) return
      if (!moved && Math.abs(move.clientX - startX) < 6) return
      const host = strip.current
      if (host === null) return
      const tabs = [...host.querySelectorAll<HTMLElement>('[data-tab-id]')]
      const from = tabs.findIndex((tab) => tab.dataset.tabId === sessionId)
      const to = dropIndex(host, move.clientX, sessionId)
      // A wobble during a click that would leave the tab where it is, is a
      // click, not a drag: only an actual reorder swallows the click.
      if (!moved && to === from) return
      moved = true
      dragged.current = true
      if (to !== from) moveSessionTo(sessionId, to)
    }
    const onUp = (): void => {
      drag.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      // The click that follows the release must not also select the tab.
      if (moved) window.setTimeout(() => { dragged.current = false }, 0)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
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

      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        ref={strip}
        data-session-tabs
        aria-label="Session tabs, swipe with two fingers to switch"
      >
        {sessions.filter((session) => !session.closed).map((session) => {
          const isActive = session.id === activeSessionId
          const running =
            Object.values(activeRuns).some((run) => run.sessionId === session.id) ||
            Object.values(mirrorRuns).some((entry) => entry.sessionId === session.id)
          return (
            <div
              key={session.id}
              // The active tab carries a glass box and a lime underline so it
              // reads at a glance even among many dark tabs; inactive tabs stay
              // bare and gain the box only under the cursor.
              data-tab-id={session.id}
              // The whole tab selects, not only its title: with many tabs the
              // title shrinks to a sliver and clicks on the badge or padding
              // used to do nothing. Tabs keep a minimum width and the strip
              // scrolls instead of crushing them.
              role="tab"
              aria-selected={isActive}
              className={`region-no-drag group relative flex h-9 ${iconOnly ? 'min-w-12 flex-1 basis-0 justify-center pl-1 pr-5' : 'max-w-44 min-w-[6.5rem] flex-1 basis-0 gap-2 pl-2.5 pr-7'} shrink-0 cursor-pointer items-center rounded-lg transition-colors ${
                isActive ? 'glass-control text-text' : 'glass-ghost text-dim'
              }`}
              onPointerDown={(event) => startDrag(session.id, event)}
              onClickCapture={(event) => {
                if (!dragged.current) return
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={() => onSelectSession(session.id)}
              title={iconOnly ? session.title : undefined}
              onAuxClick={(event) => { if (iconOnly && event.button === 1) close(session.id) }}
            >
              {isActive && (
                <span
                  aria-hidden
                  className={`absolute -bottom-px h-0.5 rounded-full bg-brand ${iconOnly ? 'inset-x-1.5' : 'inset-x-3'}`}
                />
              )}
              <Badge
                label={badgeName(session)}
                colour={session.colour}
                size={iconOnly ? 'md' : 'sm'}
                spinning={running}
              />
              {!iconOnly && <button
                type="button"
                title={session.title}
                className={`min-w-0 flex-1 truncate text-left text-[14px] transition-colors group-hover:text-brand ${
                  isActive ? 'text-text' : 'text-dim'
                }`}
              >
                {session.title}
              </button>}
              {(iconOnly || isActive || !crowded) && <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  close(session.id)
                }}
                // Not pressing a drag start either: closing never reorders.
                onPointerDown={(event) => event.stopPropagation()}
                aria-label="Close tab"
                // An invisible × takes no clicks. Once the strip is crowded,
                // inactive tabs carry no × at all (as in Chrome): a click on a
                // narrow tab selects it and never closes it by surprise.
                className={`absolute right-1 top-2 z-10 flex h-5 w-5 items-center justify-center rounded text-faint transition-[opacity,color] hover:text-brand focus-visible:pointer-events-auto focus-visible:opacity-100 ${
                    isActive ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
                  }`}
              >
                ×
              </button>}
              {/* Reorder by dragging the tab itself anywhere along the strip;
                  a plain click still just selects it. Right-click on an edge
                  nudges it one slot, for anyone who prefers no dragging. */}
              <div
                role="navigation"
                aria-label="Reorder tab"
                className="absolute inset-y-0 left-0 w-1.5"
                onContextMenu={(event) => {
                  event.preventDefault()
                  moveSession(session.id, 'left')
                }}
              />
              <div
                role="navigation"
                aria-label="Reorder tab"
                className="absolute inset-y-0 right-0 w-1.5"
                onContextMenu={(event) => {
                  event.preventDefault()
                  moveSession(session.id, 'right')
                }}
              />
            </div>
          )
        })}

      </div>

      {/* Usage and settings sit on the same row as the session tabs, outside
          the scrolling strip, whose overflow would clip the usage popover. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        <button
          type="button"
          onClick={onNewTab}
          aria-label="New tab"
          title="New tab"
          className="glass-ghost region-no-drag flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-dim hover:text-brand"
        >
          +
        </button>
        {activeSession !== undefined && <BrowserButton sessionId={activeSession.id} />}
        {activeSession !== undefined && <UsageButton session={activeSession} />}
        <button
          type="button"
          onClick={onOpenSchedule}
          title="Schedule"
          aria-pressed={scheduleActive}
          className={`glass-ghost region-no-drag flex h-7 w-7 items-center justify-center rounded-md hover:text-brand ${
            scheduleActive ? 'text-brand' : 'text-dim'
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <circle cx="8" cy="8" r="5.6" />
            <path d="M8 4.8V8l2.2 1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
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
