import { useEffect, useLayoutEffect, useRef } from 'react'
import type { JSX } from 'react'
import type { ApprovalDecision, ApprovalRequest, RiskTier } from '@shared/ipc'
import { DiffView } from './DiffView'

const RISK_LABEL: Record<RiskTier, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high'
}

interface ApprovalModalProps {
  request: ApprovalRequest
  onDecide: (decision: ApprovalDecision) => void
}

/**
 * Escape rejects only when nothing else wants it. Pressed in a text field or
 * with a menu open, it means "close this", and throwing away the pending
 * change with it would be a decision nobody made.
 */
export function escapeRejects(event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'target'>): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false
  const target = event.target
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return false
  }
  return document.querySelector('.menu-glass') === null
}

/**
 * Floats directly above the composer instead of covering the screen or
 * pushing the window down: the conversation and the pending action stay
 * visible together, and nothing under it moves.
 */
export function ApprovalModal({ request, onDecide }: ApprovalModalProps): JSX.Element {
  useEffect(() => {
    // Capture phase: decided before a menu's own Escape closes it, so an open
    // menu is still there to be seen.
    const onKey = (event: KeyboardEvent): void => {
      if (escapeRejects(event)) onDecide('reject')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDecide])

  // The card covers the end of the transcript, so the transcript makes room
  // for it: the prompt that asked for this stays readable above the card.
  const cardRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    const root = document.documentElement
    const sync = (): void => {
      const box = document.querySelector('[data-transcript]')?.parentElement ?? null
      const atEnd = box !== null && box.scrollHeight - box.scrollTop - box.clientHeight < 80
      root.style.setProperty('--approval-height', `${card.getBoundingClientRect().height}px`)
      if (box !== null && atEnd) box.scrollTop = box.scrollHeight
    }
    const observer = new ResizeObserver(sync)
    observer.observe(card)
    sync()
    return () => {
      observer.disconnect()
      root.style.removeProperty('--approval-height')
    }
  }, [])

  const { preview } = request

  return (
    <div
      ref={cardRef}
      data-approval
      className="pointer-events-none fixed inset-x-0 z-10 px-10"
      style={{ bottom: 'calc(var(--composer-offset, 16px) + 8px)' }}
    >
      <div className="glass-surface pointer-events-auto mx-auto max-w-3xl overflow-hidden rounded-xl border border-line shadow-2xl">
        <header className="flex items-baseline gap-2.5 px-5 py-3">
          <span className="text-[14px] text-text">
            {/^mcp__(.+?)__(.+)$/.test(request.toolName)
              ? request.toolName.replace(/^mcp__(.+?)__(.+)$/, '$2 · MCP $1')
              : request.toolName}
          </span>
          <span
            className={`text-[11.5px] ${request.risk === 'high' ? 'text-del' : 'text-dim'}`}
          >
            {RISK_LABEL[request.risk]} risk
          </span>
          <span className="ml-auto min-w-0 truncate font-mono text-[11.5px] text-faint">
            {preview.subject}
          </span>
        </header>

        {preview.kind === 'diff' ? (
          <div className="border-y border-line-soft px-5 py-3">
            <DiffView patch={preview.detail} path={preview.subject} maxHeight="max-h-[45vh]" />
          </div>
        ) : (
          <div className="max-h-48 overflow-auto border-y border-line-soft px-5 py-3">
            <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">
              {preview.detail}
            </pre>
          </div>
        )}

        <footer className="flex items-center gap-2 px-5 py-3">
          {request.risk === 'high' && (
            <span className="mr-auto text-[11.5px] text-faint">
              High risk asks again on every call.
            </span>
          )}

          <button
            type="button"
            onClick={() => onDecide('reject')}
            className={`rounded-md px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand ${
              request.risk === 'high' ? '' : 'ml-auto'
            }`}
          >
            Reject
          </button>

          {request.allowAlways && (
            <button
              type="button"
              onClick={() => onDecide('always')}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand"
            >
              Always allow
            </button>
          )}

          <button
            type="button"
            onClick={() => onDecide('approve')}
            className="glass-control rounded-md border px-4 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
          >
            Approve
          </button>
        </footer>
      </div>
    </div>
  )
}
