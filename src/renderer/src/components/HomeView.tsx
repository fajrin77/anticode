import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { Badge } from './Badge'
import { UsageChart } from './UsageChart'

interface HomeViewProps {
  onAddProject: () => void
  onSelectProject: (root: string) => void
  onOpenSettings: () => void
  onStart: (mode: 'chat' | 'code') => void
  activeProjectRoot: string | null
}

function ModeCard({
  title,
  hint,
  disabled,
  onClick,
  icon
}: {
  title: string
  hint: string
  disabled: boolean
  onClick: () => void
  icon: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 rounded-xl border px-4 py-4 text-left transition-colors ${
        disabled
          ? 'cursor-not-allowed border-line-soft text-faint'
          : 'border-line text-text hover:border-dim hover:bg-raised'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className={disabled ? 'text-faint' : 'text-dim'}>{icon}</span>
        <span className="text-[14px]">{title}</span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-faint">{hint}</p>
    </button>
  )
}

function groupLabel(timestamp: number): string {
  const day = 86_400_000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (timestamp >= startOfToday) return 'Hari ini'
  if (timestamp >= startOfToday - day) return 'Kemarin'
  return 'Sebelumnya'
}

function groupSessions(sessions: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>()
  for (const session of [...sessions].sort((a, b) => b.createdAt - a.createdAt)) {
    const label = groupLabel(session.createdAt)
    groups.set(label, [...(groups.get(label) ?? []), session])
  }
  return [...groups.entries()]
}

export function HomeView({
  onAddProject,
  onSelectProject,
  onOpenSettings,
  onStart,
  activeProjectRoot
}: HomeViewProps): JSX.Element {
  const [query, setQuery] = useState('')
  const projects = useSessionStore((state) => state.projects)
  const sessions = useSessionStore((state) => state.sessions)
  const selectSession = useSessionStore((state) => state.selectSession)

  const activeName =
    projects.find((project) => project.root === activeProjectRoot)?.name ?? 'project'

  const visible = useMemo(() => {
    // Chat sessions have no folder, so they stay visible whichever project is picked.
    const scoped = sessions.filter(
      (session) => session.mode === 'chat' || session.projectRoot === activeProjectRoot
    )
    const needle = query.trim().toLowerCase()
    return needle === ''
      ? scoped
      : scoped.filter((session) => session.title.toLowerCase().includes(needle))
  }, [sessions, activeProjectRoot, query])

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col px-3 pt-6 pb-4">
        <div className="mb-3 flex items-center justify-between px-2">
          <span className="text-[15px] text-text">Projects</span>
          <button
            type="button"
            onClick={onAddProject}
            title="Tambah project"
            className="text-faint transition-colors hover:text-text"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
              <path d="M8 7.2v3.4M6.3 8.9h3.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto">
          {projects.length === 0 && (
            <p className="px-2 text-[13px] leading-relaxed text-faint">
              Belum ada project. Tambahkan folder untuk mulai.
            </p>
          )}
          {projects.map((project) => (
            <button
              key={project.root}
              type="button"
              onClick={() => onSelectProject(project.root)}
              className={`mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                project.root === activeProjectRoot
                  ? 'bg-hover text-text'
                  : 'text-dim hover:bg-raised'
              }`}
            >
              <Badge name={project.name} size="md" />
              <span className="truncate text-[13px]">{project.name}</span>
            </button>
          ))}
        </nav>

        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-2 flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-dim transition-colors hover:bg-raised hover:text-text"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8L3.5 3.5" strokeLinecap="round" />
          </svg>
          Settings
        </button>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col px-10 pt-6 pb-8">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search sessions in ${activeName}`}
          className="mb-8 w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-[14px] text-text outline-none placeholder:text-faint focus:border-hover"
        />

        <UsageChart />

        <div className="mb-8 flex gap-3">
          <ModeCard
            title="antichat"
            hint="Tanya jawab biasa. Tanpa folder, tanpa akses berkas maupun terminal."
            disabled={false}
            onClick={() => onStart('chat')}
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h9.6A1.2 1.2 0 0 1 14 4.2v5.6a1.2 1.2 0 0 1-1.2 1.2H6.5L3.4 13.4V11h-.2A1.2 1.2 0 0 1 2 9.8z" strokeLinejoin="round" />
              </svg>
            }
          />
          <ModeCard
            title="anticode"
            hint={
              activeProjectRoot === null
                ? 'Pilih folder project dulu di daftar sebelah kiri.'
                : `Bekerja di folder ${activeName}, dengan akses berkas dan terminal.`
            }
            disabled={activeProjectRoot === null}
            onClick={() => onStart('code')}
            icon={
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor">
                <path d="M6 11.5L2.5 8 6 4.5M10 4.5L13.5 8 10 11.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
        </div>

        <div className="mb-3">
          <span className="text-[13px] text-dim">
            {visible.length === 0 ? 'Belum ada sesi' : groupSessions(visible)[0]?.[0]}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {groupSessions(visible).map(([label, group], index) => (
            <section key={label}>
              {index > 0 && <div className="mt-6 mb-3 text-[13px] text-dim">{label}</div>}
              {group.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => selectSession(session.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-raised"
                >
                  <Badge name={session.mode === 'chat' ? 'antichat' : activeName} />
                  <span className="truncate text-[14px] text-text">{session.title}</span>
                  {session.mode === 'chat' && (
                    <span className="ml-auto shrink-0 text-[11.5px] text-faint">antichat</span>
                  )}
                </button>
              ))}
            </section>
          ))}
        </div>
      </main>
    </div>
  )
}
