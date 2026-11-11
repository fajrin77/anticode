import { useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { Badge } from './Badge'

export function SessionSidebar({ active, dashboardActive, onDashboard, onSelectSession, onNewSession }: {
  active: boolean
  dashboardActive: boolean
  onDashboard: () => void
  onSelectSession: (id: string) => void
  onNewSession: (id: string) => void
}): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const activeId = useSessionStore((state) => state.activeSessionId)
  const activeRuns = useSessionStore((state) => state.activeRuns)
  const mirrorRuns = useSessionStore((state) => state.mirrorRuns)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    if (session.closed && session.messages.length === 0) continue
    const key = session.mode === 'chat' ? 'antichat' : session.projectRoot ?? ''
    const group = groups.get(key) ?? []
    group.push(session)
    groups.set(key, group)
  }
  const running = new Set([...Object.values(activeRuns), ...Object.values(mirrorRuns)].map((run) => run.sessionId))

  return (
    <aside id="session-sidebar" aria-label="Daftar sesi" className="flex w-64 max-w-[40vw] shrink-0 flex-col border-r border-line-soft bg-raised/40 p-3">
      <button type="button" onClick={onDashboard} aria-pressed={dashboardActive}
        className={`mb-5 rounded-lg px-3 py-2 text-left text-[14px] hover:bg-raised hover:text-brand ${dashboardActive ? 'bg-raised text-brand' : 'text-text'}`}>
        + New Season
      </button>
      <nav aria-label="Sesi per project" className="min-h-0 flex-1 overflow-y-auto">
        {groups.size === 0 && <p className="px-3 text-[12px] text-faint">Belum ada sesi.</p>}
        {[...groups].map(([root, entries], index) => {
          const label = root === '' ? 'Tanpa project' : root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
          const expanded = !collapsed.has(root)
          return (
            <section key={root} className="mb-4">
              <div className="flex items-center gap-1">
                <button type="button" aria-expanded={expanded} aria-controls={`project-sessions-${index}`} title={root || label}
                  onClick={() => setCollapsed((current) => {
                    const next = new Set(current)
                    if (next.has(root)) next.delete(root)
                    else next.add(root)
                    return next
                  })}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-faint hover:text-text">
                  <span aria-hidden>{expanded ? '⌄' : '›'}</span><span className="truncate">{label}</span>
                </button>
                <button type="button" onClick={() => onNewSession(entries[0]!.id)}
                  aria-label={`Sesi baru di ${label}`} title={`Sesi baru di ${label}`}
                  className="h-7 w-7 shrink-0 rounded-md text-dim hover:bg-raised hover:text-brand">+</button>
              </div>
              {expanded && <div id={`project-sessions-${index}`}>
                {entries.map((session) => (
                  <button type="button" key={session.id} title={session.title} data-session-id={session.id}
                    onClick={() => onSelectSession(session.id)} aria-current={active && session.id === activeId ? 'page' : undefined}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-raised hover:text-brand ${active && session.id === activeId ? 'bg-raised text-text' : 'text-dim'}`}>
                    <Badge label={label} colour={session.colour} size="sm" spinning={running.has(session.id)} />
                    <span className="min-w-0 flex-1 truncate">{session.title}</span>
                  </button>
                ))}
              </div>}
            </section>
          )
        })}
      </nav>
    </aside>
  )
}
