import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { sidebarProjectOrder, useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { Badge } from './Badge'

function SessionActions({ session, onNewSession }: { session: Session; onNewSession: (id: string) => void }): JSX.Element {
  const id = useId()
  const popover = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'archive' | 'delete' | 'export'): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (action === 'export') await window.anticode.exportSession(session.id)
      else if (action === 'archive') {
        await window.anticode.pauseSession(session.id)
        useSessionStore.getState().closeSession(session.id)
      } else {
        const state = useSessionStore.getState()
        for (const [runId, run] of [...Object.entries(state.activeRuns), ...Object.entries(state.mirrorRuns)]) {
          if (run.sessionId === session.id) await window.anticode.cancelRun(runId)
        }
        await window.anticode.closeSession(session.id)
        useSessionStore.getState().deleteSession(session.id)
      }
      popover.current?.hidePopover()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <button type="button" popoverTarget={id} aria-label={`Opsi sesi ${session.title}`} title="Opsi sesi"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setPosition({ left: Math.max(8, Math.min(box.right - 224, window.innerWidth - 232)), top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - 300)) })
        setConfirming(false)
        setError(null)
      }}
      className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim opacity-0 hover:bg-hover hover:text-brand group-hover:opacity-100 focus-visible:opacity-100" >
      <span aria-hidden>⋯</span>
    </button>
    <div id={id} ref={popover} popover="auto" aria-label={`Tindakan sesi ${session.title}`}
      style={position} className="menu-glass fixed m-0 max-h-[calc(100vh-16px)] w-56 overflow-y-auto rounded-xl border p-1.5 text-[13px] text-text">
      <button type="button" disabled={busy} onClick={() => { popover.current?.hidePopover(); onNewSession(session.id) }} className="w-full rounded-md px-3 py-2 text-left hover:bg-hover disabled:opacity-50">Sesi baru di project ini</button>
      <button type="button" disabled={busy} onClick={() => void act('export')} className="w-full rounded-md px-3 py-2 text-left hover:bg-hover disabled:opacity-50">Ekspor percakapan…</button>
      <button type="button" disabled={busy} onClick={() => void act('archive')} className="w-full rounded-md px-3 py-2 text-left hover:bg-hover disabled:opacity-50">Arsipkan</button>
      <button type="button" disabled={busy} onClick={() => confirming ? void act('delete') : setConfirming(true)} className="w-full rounded-md px-3 py-2 text-left text-del hover:bg-hover disabled:opacity-50">{confirming ? 'Konfirmasi hapus permanen' : 'Hapus'}</button>
      {confirming && <p className="px-3 py-2 text-[12px] text-dim">Percakapan, checkpoint, dan file sesi akan dihapus permanen.</p>}
      {error && <p role="alert" className="px-3 py-2 text-[12px] text-del [overflow-wrap:anywhere]">{error}</p>}
    </div>
  </>
}

export function SessionSidebar({ preview = false, collapsed, onToggleProject, active, dashboardActive, onDashboard, onSelectSession, onNewSession }: {
  preview?: boolean
  collapsed: ReadonlySet<string>
  onToggleProject: (root: string) => void
  active: boolean
  dashboardActive: boolean
  onDashboard: () => void
  onSelectSession: (id: string) => void
  onNewSession: (id: string) => void
}): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const projectOrder = useSessionStore((state) => state.projectOrder)
  const syncProjectOrder = useSessionStore((state) => state.syncProjectOrder)
  const moveProject = useSessionStore((state) => state.moveProject)
  const draggedProject = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ root: string; after: boolean } | null>(null)
  useLayoutEffect(() => { syncProjectOrder() }, [sessions, syncProjectOrder])
  const activeId = useSessionStore((state) => state.activeSessionId)
  const activeRuns = useSessionStore((state) => state.activeRuns)
  const mirrorRuns = useSessionStore((state) => state.mirrorRuns)
  const [showArchived, setShowArchived] = useState(false)
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    if (session.closed && !showArchived) continue
    const key = session.mode === 'chat' ? 'antichat' : session.projectRoot ?? ''
    const group = groups.get(key) ?? []
    group.push(session)
    groups.set(key, group)
  }
  const running = new Set([...Object.values(activeRuns), ...Object.values(mirrorRuns)].map((run) => run.sessionId))
  const orderedGroups = sidebarProjectOrder({ projectOrder, sessions }).filter((root) => groups.has(root))

  return (
    <aside id="session-sidebar" aria-label="Daftar sesi" className={`flex w-64 max-w-[40vw] shrink-0 flex-col border-r border-line-soft p-3 ${preview ? 'bg-raised/80' : 'bg-raised/40'}`}>
      <button type="button" onClick={onDashboard} aria-pressed={dashboardActive}
        className={`mb-5 rounded-lg px-3 py-2 text-left text-[14px] hover:bg-raised hover:text-brand ${dashboardActive ? 'bg-raised text-brand' : 'text-text'}`}>
        + New Session
      </button>
      <nav aria-label="Sesi per project" className="sidebar-scroll min-h-0 flex-1 overflow-y-auto">
        {groups.size === 0 && <p className="px-3 text-[12px] text-faint">Belum ada sesi.</p>}
        {orderedGroups.map((root, index) => {
          const entries = groups.get(root)!
          const label = root === '' ? 'Tanpa project' : root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
          const expanded = !collapsed.has(root)
          return (
            <section key={root} className="mb-1">
              <div className={`flex items-center gap-1 rounded-md ${dropTarget?.root === root ? (dropTarget.after ? 'shadow-[0_2px_0_var(--color-brand)]' : 'shadow-[0_-2px_0_var(--color-brand)]') : ''}`}
                onDragOver={(event) => {
                  if (draggedProject.current === null || draggedProject.current === root) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  const box = event.currentTarget.getBoundingClientRect()
                  setDropTarget({ root, after: event.clientY > box.top + box.height / 2 })
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (draggedProject.current !== null) {
                    const box = event.currentTarget.getBoundingClientRect()
                    moveProject(draggedProject.current, root, event.clientY > box.top + box.height / 2)
                  }
                  draggedProject.current = null
                  setDropTarget(null)
                }}>
                <button type="button" draggable aria-expanded={expanded} aria-controls={`project-sessions-${index}`} title={`${root || label} — tarik untuk mengurutkan; Alt+↑/↓`}
                  onDragStart={(event) => {
                    draggedProject.current = root
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', root)
                  }}
                  onDragEnd={() => { draggedProject.current = null; setDropTarget(null) }}
                  onKeyDown={(event) => {
                    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
                    event.preventDefault()
                    const down = event.key === 'ArrowDown'
                    const target = orderedGroups[index + (down ? 1 : -1)]
                    if (target !== undefined) moveProject(root, target, down)
                  }}
                  onClick={() => onToggleProject(root)}
                  className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 py-1 text-left text-[14px] text-faint transition-colors hover:text-brand active:cursor-grabbing">
                  <span aria-hidden>{expanded ? '⌄' : '›'}</span><span className="truncate">{label}</span>
                </button>
                <button type="button" onClick={() => onNewSession((entries.find((session) => session.id === activeId) ?? entries.at(-1)!).id)}
                  aria-label={`Sesi baru di ${label}`} title={`Sesi baru di ${label}`}
                  className="h-7 w-7 shrink-0 rounded-md text-dim transition-colors hover:bg-raised hover:text-brand">+</button>
              </div>
              {expanded && <div id={`project-sessions-${index}`}>
                {entries.map((session) => (
                  <div key={session.id} className={`group flex items-center rounded-lg hover:bg-raised ${active && session.id === activeId ? 'bg-raised' : ''}`} >
                  <button type="button" title={session.title} data-session-id={session.id}
                    onClick={() => onSelectSession(session.id)} aria-current={active && session.id === activeId ? 'page' : undefined}
                    className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left text-[14px] hover:bg-raised hover:text-brand ${active && session.id === activeId ? 'bg-raised text-text' : 'text-dim'}`}>
                    <Badge label={label} colour={session.colour} size="sm" spinning={running.has(session.id)} />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  </button>
                  <SessionActions session={session} onNewSession={onNewSession} />
                  </div>
                ))}
              </div>}
            </section>
          )
        })}
      </nav>
      {sessions.some((session) => session.closed) && <button type="button" aria-pressed={showArchived}
        onClick={() => setShowArchived((shown) => !shown)} className="mt-2 rounded-md px-3 py-2 text-left text-[12px] text-dim hover:bg-raised hover:text-brand">
        {showArchived ? 'Sembunyikan arsip' : 'Tampilkan arsip'}
      </button>}
    </aside>
  )
}
