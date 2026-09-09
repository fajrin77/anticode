import { useEffect } from 'react'
import type { JSX } from 'react'
import type { ApprovalDecision, ApprovalRequest, RiskTier } from '@shared/ipc'

const RISK_LABEL: Record<RiskTier, string> = {
  low: 'rendah',
  medium: 'sedang',
  high: 'tinggi'
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-10">
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
        <header className="flex items-baseline gap-2.5 px-5 py-3.5">
          <span className="text-[15px] text-text">{request.toolName}</span>
          <span
            className={`text-[11.5px] ${request.risk === 'high' ? 'text-del' : 'text-dim'}`}
          >
            risiko {RISK_LABEL[request.risk]}
          </span>
          <span className="ml-auto min-w-0 truncate font-mono text-[11.5px] text-faint">
            {preview.subject}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-auto border-y border-line-soft px-5 py-4">
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

        <footer className="flex items-center gap-2 px-5 py-3.5">
          {request.risk === 'high' && (
            <span className="mr-auto text-[11.5px] text-faint">
              Risiko tinggi diminta ulang tiap panggilan.
            </span>
          )}

          <button
            type="button"
            onClick={() => onDecide('reject')}
            className={`rounded-md px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-text ${
              request.risk === 'high' ? '' : 'ml-auto'
            }`}
          >
            Tolak
          </button>

          {request.allowAlways && (
            <button
              type="button"
              onClick={() => onDecide('always')}
              className="rounded-md px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-text"
            >
              Selalu izinkan
            </button>
          )}

          <button
            type="button"
            onClick={() => onDecide('approve')}
            className="rounded-md bg-hover px-4 py-1.5 text-[12.5px] text-text transition-colors hover:bg-[#3a3a3a]"
          >
            Setujui
          </button>
        </footer>
      </div>
    </div>
  )
}
