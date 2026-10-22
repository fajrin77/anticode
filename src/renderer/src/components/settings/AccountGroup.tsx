import { useId } from 'react'
import type { ReactNode, JSX } from 'react'

/** One disclosure per service; controls stay outside the disclosure button. */
export function AccountGroup({ id, title, count, expanded, onToggle, action, children }: {
  id: string
  title: string
  count: number
  expanded: boolean
  onToggle: () => void
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  const panelId = useId()
  return (
    <section data-account-group={id} className="border-b border-line-soft last:border-b-0">
      <div className="flex items-center gap-3 px-5 py-3.5">
        <button type="button" aria-expanded={expanded} aria-controls={panelId}
          onClick={onToggle} className="group flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 text-left text-text outline-none transition-colors hover:text-brand focus-visible:ring-1 focus-visible:ring-brand">
          <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3.5 w-3.5 shrink-0 text-faint transition-[transform,color] group-hover:text-brand ${expanded ? 'rotate-90' : ''}`}>
            <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="min-w-0 flex-1 text-[13.5px]">{title}</span>
          <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{count ? `${count} ${count === 1 ? 'account' : 'accounts'}` : 'Not connected'}</span>
        </button>
        {action}
      </div>
      <div id={panelId} hidden={!expanded} className="border-t border-line-soft bg-surface/20">{children}</div>
    </section>
  )
}
