import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { Message } from '../store/session'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * The session's current plan: the latest checklist `todo_write` published.
 * Each call replaces the whole list, so the newest one is the plan — a failed
 * call never replaced anything, so it is skipped. A call still running counts:
 * the model publishes its new list the moment it starts the call, and waiting
 * for the tool result would leave the panel a step behind the run.
 */
export function latestPlan(messages: Message[]): TodoItem[] | null {
  // A new typed prompt starts a new run. Never borrow the checklist from a
  // previous run while the new reply is still empty or creating its own plan.
  const boundary = messages.findLastIndex((message) =>
    message.role === 'user' && message.followUp !== true && message.parts.some((part) => part.kind === 'text')
  )
  for (let i = messages.length - 1; i >= Math.max(0, boundary); i--) {
    const parts = messages[i]?.parts ?? []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.kind !== 'tool' || part.name !== 'todo_write' || part.status === 'error') continue
      const items = (part.input as { items?: unknown } | null)?.items
      if (!Array.isArray(items)) continue
      const plan = items.filter(
        (item): item is TodoItem =>
          typeof item?.content === 'string' && ['pending', 'in_progress', 'completed'].includes(item?.status)
      )
      if (plan.length > 0) return plan
    }
  }
  return null
}

function Mark({ status }: { status: TodoItem['status'] }): JSX.Element {
  if (status === 'completed') {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-add" aria-hidden>
        <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (status === 'in_progress') return <span className="mx-[3px] h-1.5 w-1.5 shrink-0 animate-breathe rounded-full bg-text" aria-hidden />
  return <span className="mx-[2px] h-2 w-2 shrink-0 rounded-full border border-faint" aria-hidden />
}

/**
 * The plan, pinned above the composer while it matters: shown only for work
 * covering three or more user outcomes, and only while its run is alive.
 * The header opens and closes it while that work is in progress.
 */
export function TodoPanel({ sessionId, messages, working }: { sessionId: string; messages: Message[]; working: boolean }): JSX.Element | null {
  const open = useSessionStore((state) => state.planOpenBySession[sessionId])
  const setPlanOpen = useSessionStore((state) => state.setPlanOpen)
  const plan = latestPlan(messages)
  if (plan === null || plan.length < 3 || !working) return null
  const done = plan.filter((item) => item.status === 'completed').length
  const finished = done === plan.length
  const current = plan.find((item) => item.status === 'in_progress') ?? plan.find((item) => item.status === 'pending')
  const expanded = open ?? true

  return (
    <div className="composer-glass mb-2 overflow-hidden rounded-xl border border-line" data-todo-panel>
      <button
        type="button"
        onClick={() => setPlanOpen(sessionId, !expanded)}
        aria-expanded={expanded}
        className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px]"
      >
        <span className="shrink-0 text-dim transition-colors group-hover:text-brand">Plan</span>
        <span className="shrink-0 tabular-nums text-faint">
          {done}/{plan.length}
        </span>
        <span className="min-w-0 flex-1 truncate text-dim">
          {finished ? 'all done' : !expanded && current !== undefined ? current.content : ''}
        </span>
        <span className="shrink-0 text-[11px] text-faint transition-colors group-hover:text-brand">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && (
        <ol className="max-h-48 overflow-y-auto px-3 pb-2 [scrollbar-gutter:stable]">
          {plan.map((item, index) => (
            <li key={index} className="flex items-center gap-2.5 py-0.5 text-[12.5px]">
              <Mark status={item.status} />
              <span
                className={
                  item.status === 'completed'
                    ? 'text-faint line-through decoration-faint/60'
                    : item.status === 'in_progress'
                      ? 'text-text'
                      : 'text-dim'
                }
              >
                {item.content}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
