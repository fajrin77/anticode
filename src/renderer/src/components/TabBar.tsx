import { useEffect, useRef, useState } from 'react'
import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { useWebSession } from '../store/web'
import { contextWindowFor, historyBudgetFor, ROTATE_PROVIDER } from '@shared/ipc'
import type { SubscriptionQuota } from '@shared/ipc'
import { quotaResetLabel, quotaWindowLabel } from './settings/subscriptionUsageFormat'
import { formatUsd } from '../money'
import { InstructionsField } from './InstructionsField'

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * A popover that opens on a click, or on a mouse that rests on it for a second
 * — the same rule the temporary sidebar follows. Leaving closes it again, so
 * the panel belongs to the pointer and no second click is needed. The grace on
 * the way out is the gap between the icon and the panel it hangs below.
 */
function useDwellPopover(
  open: boolean,
  setOpen: (next: boolean) => void
): {
  onPointerEnter: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerLeave: () => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clear = (): void => clearTimeout(timer.current)
  useEffect(() => () => clearTimeout(timer.current), [])
  // A pending open must not reopen a panel the user just clicked shut.
  useEffect(() => { if (open) clearTimeout(timer.current) }, [open])
  return {
    onPointerEnter: (event) => {
      clear()
      if (open || event.pointerType !== 'mouse') return
      timer.current = setTimeout(() => setOpen(true), 1000)
    },
    onPointerLeave: () => {
      clear()
      timer.current = setTimeout(() => setOpen(false), 180)
    }
  }
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
        // The summary card the compaction left belongs in this transcript too.
        if (after < before) {
          void window.anticode.getSessionSnapshot(session.id).then((snapshot) => {
            if (snapshot !== null) useSessionStore.getState().importSnapshot(session.id, snapshot.messages, snapshot.summaries)
          })
        }
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
  const dwell = useDwellPopover(open, setOpen)

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
    <div className="region-no-drag relative" ref={boxRef} {...dwell}>
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
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onSidebarPointerEnter: () => void
  onSidebarPointerLeave: () => void
  /** True while the dashboard view is on screen, lights the grid icon lime. */
  dashboardActive: boolean
  /** True while Settings is on screen, lights the gear the same way. */
  settingsActive: boolean
  /** True while Schedule is on screen, lights the clock the same way. */
  scheduleActive: boolean
  /** Provider the session on screen is set to, null until the status loads. */
  selectedProvider: string | null
}

/** Plan limits of the account behind the model in use; API-key routes have none to show. */
function PlanUsageButton({ provider }: { provider: string | null }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [quotas, setQuotas] = useState<SubscriptionQuota[] | null>(null)
  const [failed, setFailed] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const dwell = useDwellPopover(open, setOpen)

  useEffect(() => {
    if (!open) return
    let active = true
    setFailed(false)
    window.anticode.getSubscriptionQuotas().then((next) => { if (active) setQuotas(next) }).catch(() => { if (active) setFailed(true) })
    function onOutside(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      active = false
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, provider])

  const quota = provider === null ? undefined : quotas?.find((item) => item.provider === provider && item.status !== 'unsupported')
  const now = Date.now()
  return (
    <div className="region-no-drag relative" ref={boxRef} {...dwell}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title="Plan usage"
        aria-label="Plan usage"
        aria-expanded={open}
        data-plan-usage-toggle
        className={`glass-ghost flex h-7 w-7 items-center justify-center rounded-md hover:text-brand ${open ? 'text-brand' : 'text-dim'}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
          <path d="M2.4 11.5a5.8 5.8 0 1 1 11.2 0" />
          <path d="M8 9.6l2.4-3" />
        </svg>
      </button>
      {open && (
        <div className="menu-glass absolute top-full right-0 z-20 mt-1 w-80 rounded-xl border p-4">
          <div className="mb-2 text-[13px] text-text">{quota === undefined ? 'Plan usage' : `${quota.label} usage`}</div>
          {quota === undefined ? (
            <p className="text-[12px] text-faint">
              {failed ? 'Could not read the usage.' : quotas === null ? 'Reading usage…' : 'Usage is only shown for subscription accounts. This model runs by API key, so there is no plan limit to read.'}
            </p>
          ) : (
            <>
              {quota.error !== undefined && <p className="mb-2 text-[11.5px] text-amber-400">{quota.error}</p>}
              {quota.windows.length === 0 && <p className="text-[12px] text-faint">No limit data yet.</p>}
              {quota.windows.map((win, index) => {
                const used = win.usedPercent === null || !Number.isFinite(win.usedPercent) ? null : Math.max(0, Math.min(100, win.usedPercent))
                return (
                  <div key={`${win.label}-${index}`} className="border-t border-line-soft py-2 first:border-t-0">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[12.5px]">
                      <span className="text-text">{quotaWindowLabel(win.label)}</span>
                      <span className="tabular-nums text-faint">{used === null ? '—' : `${Math.round(100 - used)}% left`}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                      {used !== null && <div className={`h-full rounded-full ${used >= 95 ? 'bg-red-400' : used >= 80 ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${used}%` }} />}
                    </div>
                    <div className="mt-1 text-[11px] text-faint">{quotaResetLabel(win.resetAt, now)}</div>
                  </div>
                )
              })}
              {quota.account !== undefined && <div className="mt-1 truncate text-[11px] text-faint">{quota.account}{quota.plan !== undefined ? ` · ${quota.plan}` : ''}</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
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

export function TabBar({
  onDashboard, onOpenSettings, onOpenSchedule,
  sidebarOpen, onToggleSidebar, onSidebarPointerEnter, onSidebarPointerLeave, dashboardActive, settingsActive, scheduleActive, selectedProvider
}: TabBarProps): JSX.Element {
  const activeSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId && !session.closed)
  )
  // Rotate has no single model; the account of the latest turn stands in for it.
  const activeProvider = selectedProvider === null || selectedProvider === ROTATE_PROVIDER ? activeSession?.provider ?? null : selectedProvider
  return (
    <header className="desktop-header-glass region-drag flex h-12 shrink-0 items-center gap-3 pr-3 pl-20">
      <button type="button" onClick={onToggleSidebar}
        onPointerEnter={(event) => { if (event.pointerType === 'mouse') onSidebarPointerEnter() }}
        onPointerLeave={onSidebarPointerLeave}
        title="Buka/tutup sidebar (⌘/Ctrl+B)" aria-label="Buka/tutup sidebar"
        aria-expanded={sidebarOpen} aria-controls="session-sidebar"
        className="glass-ghost region-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim hover:text-brand">
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <rect x="2" y="3" width="16" height="14" rx="2" /><path d="M7 3v14" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onDashboard}
        aria-label="+ New Session"
        title="+ New Session"
        className="glass-ghost region-no-drag -ml-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dim hover:text-brand"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      <span className="min-w-0 truncate text-[13px] text-dim">
        {dashboardActive ? 'New Session' : settingsActive ? 'Settings' : scheduleActive ? 'Schedule' : activeSession?.title ?? 'anticode'}
      </span>
      {/* Keep session tools in the header so popovers stay outside sidebar scrolling. */}
      <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
        {activeSession !== undefined && <BrowserButton sessionId={activeSession.id} />}
        {activeSession !== undefined && <PlanUsageButton provider={activeProvider} />}
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
