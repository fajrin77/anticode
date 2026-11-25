import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'

export function SessionPicker({ onSelect, onClose }: { onSelect: (id: string) => void; onClose: () => void }): JSX.Element {
  const [sessions] = useState(() => [...useSessionStore.getState().sessions].reverse())
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const needle = query.toLowerCase().trim()
  const matches = sessions.filter(session => `${session.title} ${session.projectRoot ?? ''}`.toLowerCase().includes(needle))
  const pick = (id: string): void => { onSelect(id); onClose() }
  useEffect(() => {
    document.querySelector('[data-session-pick-active]')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/70 px-4 pt-20"
    onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div role="dialog" aria-modal="true" aria-label="Switch session"
      className="glass-surface w-full max-w-lg overflow-hidden rounded-xl border border-line p-2 shadow-xl">
      <input autoFocus value={query} onChange={event => { setQuery(event.target.value); setActive(0) }}
        aria-label="Search sessions" placeholder="Search sessions…" className="w-full px-3 py-2 text-sm text-text outline-none"
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
          if (!matches.length) return
          if (event.key === 'Enter') { event.preventDefault(); pick(matches[active]!.id) }
          else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setActive(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + matches.length) % matches.length)
          }
        }} />
      <div className="max-h-72 overflow-y-auto">
        {matches.map((session, index) => <button key={session.id} type="button"
          data-session-pick-active={index === active ? '' : undefined}
          onClick={() => pick(session.id)} className={`group block w-full truncate rounded px-3 py-2 text-left text-sm transition-colors hover:text-brand ${index === active ? 'bg-hover text-text' : 'text-dim'}`}>
          {session.title} <span className="text-xs text-faint transition-colors group-hover:text-brand">{session.projectRoot?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Chat'}</span>
        </button>)}
        {!matches.length && <p className="px-3 py-2 text-xs text-dim">No matching sessions.</p>}
      </div>
    </div>
  </div>
}
