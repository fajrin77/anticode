import { useEffect } from 'react'
import type { JSX } from 'react'
import type { ApprovalDecision, ApprovalRequest, RiskTier } from '@shared/ipc'

const RISK_LABEL: Record<RiskTier, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high'
}

function DiffLine({ line }: { line: string }): JSX.Element {
  const tone = line.startsWith('+')
    ? 'text-add'
    : line.startsWith('-')
      ? 'text-del'
      : line.startsWith('@@')
        ? 'text-dim'
        : 'text-faint'
  return <div className={tone}>{line === '' ? ' ' : line}</div>
}

interface ApprovalModalProps {
  request: ApprovalRequest
  onDecide: (decision: ApprovalDecision) => void
}

/**
 * Sits directly above the composer instead of covering the screen: the
 * conversation and the pending action stay visible together.
 */
export function ApprovalModal({ request, onDecide }: ApprovalModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDecide('reject')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDecide])

  const { preview } = request

  return (
    <div className="shrink-0 px-10 pb-3">
      <div className="glass-surface mx-auto max-w-3xl overflow-hidden rounded-xl border border-line shadow-2xl">
        <header className="flex items-baseline gap-2.5 px-5 py-3">
          <span className="text-[14px] text-text">{request.toolName}</span>
          <span
            className={`text-[11.5px] ${request.risk === 'high' ? 'text-del' : 'text-dim'}`}
          >
            {RISK_LABEL[request.risk]} risk
          </span>
          <span className="ml-auto min-w-0 truncate font-mono text-[11.5px] text-faint">
            {preview.subject}
          </span>
        </header>

        <div className="max-h-48 overflow-auto border-y border-line-soft px-5 py-3">
          {preview.kind === 'diff' ? (
            <div className="overflow-x-auto font-mono text-[12px] leading-relaxed">
              {preview.detail.split('\n').map((line, index) => (
                <DiffLine key={index} line={line} />
              ))}
            </div>
          ) : (
            <pre className="font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">
              {preview.detail}
            </pre>
          )}
        </div>

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
