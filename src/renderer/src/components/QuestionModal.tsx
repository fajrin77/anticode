import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { QuestionAnswer, QuestionRequest } from '@shared/ipc'
import { escapeRejects } from './ApprovalModal'

interface QuestionModalProps {
  request: QuestionRequest
  onAnswer: (answer: Omit<QuestionAnswer, 'requestId'>) => void
}

/**
 * The agent's question, answered by clicking — an option, a custom reply, or
 * a skip. Floats above the composer exactly like the approval card, so the
 * conversation that led to the question stays visible and nothing moves.
 * Answering is not destructive, so nothing here is red: options light lime.
 */
export function QuestionModal({ request, onAnswer }: QuestionModalProps): JSX.Element {
  const [custom, setCustom] = useState('')
  const firstRef = useRef<HTMLButtonElement>(null)

  // Escape outside the custom field skips the question; inside it, Escape
  // only leaves the field. A skip is an answer too — the run proceeds on its
  // own judgement instead of hanging.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (escapeRejects(event)) onAnswer({ optionId: null, text: '' })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onAnswer])

  // Announced and reachable like the approval card; focus returns after.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstRef.current?.focus()
    return () => previous?.focus()
  }, [])

  // The card covers the end of the transcript, so the transcript makes room.
  const cardRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    const card = cardRef.current
    if (card === null) return
    const root = document.documentElement
    const sync = (): void => {
      const box = document.querySelector('[data-transcript]')?.parentElement ?? null
      const atEnd = box !== null && box.scrollHeight - box.scrollTop - box.clientHeight < 80
      root.style.setProperty('--approval-height', `${card.getBoundingClientRect().height}px`)
      if (box !== null && atEnd) box.scrollTop = box.scrollHeight
      const composer = document.querySelector<HTMLElement>('[data-composer-box]')
      if (composer === null) {
        setAnchor(null)
        return
      }
      const rect = composer.getBoundingClientRect()
      setAnchor({
        left: rect.left - 40,
        width: rect.width + 80,
        bottom: window.innerHeight - rect.top + 8
      })
    }
    const observer = new ResizeObserver(sync)
    observer.observe(card)
    const composer = document.querySelector<HTMLElement>('[data-composer-box]')
    if (composer !== null) observer.observe(composer)
    window.addEventListener('resize', sync)
    sync()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
      root.style.removeProperty('--approval-height')
    }
  }, [])

  const sendCustom = (): void => {
    if (custom.trim() === '') return
    onAnswer({ optionId: null, text: custom.trim() })
  }

  return (
    <div
      className="pointer-events-none fixed z-10"
      style={
        anchor !== null
          ? { left: anchor.left, width: anchor.width, bottom: anchor.bottom }
          : {
              left: 0,
              bottom: 16,
              width: '100vw',
              maxWidth: 'calc(100vw - 80px)',
              paddingLeft: 40,
              paddingRight: 40
            }
      }
    >
      <div
        ref={cardRef}
        data-question
        role="dialog"
        aria-modal="true"
        aria-label="The agent has a question"
        className="glass-surface pointer-events-auto mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-line shadow-2xl"
      >
        <header className="flex items-baseline gap-2.5 px-5 py-3">
          <span className="text-[14px] text-text">Pertanyaan</span>
          <span className="ml-auto min-w-0 truncate font-mono text-[11.5px] text-faint">
            ask_question
          </span>
        </header>

        <div className="border-y border-line-soft px-5 py-3">
          <p className="text-[13px] leading-relaxed text-text">{request.question}</p>
        </div>

        <div className="flex flex-col gap-1.5 px-5 py-3">
          {request.options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              ref={index === 0 ? firstRef : undefined}
              onClick={() => onAnswer({ optionId: option.id, text: '' })}
              className="group rounded-lg border border-line-soft px-3 py-2 text-left transition-colors hover:border-hover hover:bg-raised"
            >
              <span className="block text-[13px] text-text transition-colors group-hover:text-brand">
                {option.label}
              </span>
              {option.hint !== undefined && (
                <span className="block text-[11.5px] text-faint">{option.hint}</span>
              )}
            </button>
          ))}
        </div>

        <footer className="flex items-center gap-2 px-5 py-3">
          <button
            type="button"
            onClick={() => onAnswer({ optionId: null, text: '' })}
            className="rounded-md px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:bg-raised hover:text-brand"
          >
            Lewati
          </button>
          {request.allowCustom && (
            <div className="ml-auto flex min-w-0 flex-1 items-center gap-2">
              <input
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') sendCustom()
                }}
                placeholder="Atau jawab sendiri…"
                aria-label="Jawaban sendiri"
                className="glass-field min-w-0 flex-1 rounded-md border border-line bg-transparent px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-hover"
              />
              <button
                type="button"
                onClick={sendCustom}
                disabled={custom.trim() === ''}
                className="rounded-md px-3 py-1.5 text-[12.5px] text-text transition-colors hover:bg-raised hover:text-brand disabled:cursor-not-allowed disabled:text-faint"
              >
                Kirim
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}
