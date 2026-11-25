import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { QuestionAnswer, QuestionRequest } from '@shared/ipc'

interface QuestionModalProps {
  request: QuestionRequest
  onAnswer: (answer: Omit<QuestionAnswer, 'requestId'>) => void
}

/**
 * The agent's question, answered by clicking, an option, a custom reply, or
 * a skip. Floats above the composer exactly like the approval card, so the
 * conversation that led to the question stays visible and nothing moves.
 * Answering is not destructive, so nothing here is red: options light lime.
 */
export function QuestionModal({ request, onAnswer }: QuestionModalProps): JSX.Element {
  const [custom, setCustom] = useState('')
  const firstRef = useRef<HTMLButtonElement>(null)

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
      const next = {
        left: rect.left - 40,
        width: rect.width + 80,
        bottom: window.innerHeight - rect.top + 8
      }
      // Unchanged geometry returns the same object, so polling costs no render.
      setAnchor((prev) =>
        prev !== null && prev.left === next.left && prev.width === next.width && prev.bottom === next.bottom
          ? prev
          : next
      )
    }
    const observer = new ResizeObserver(sync)
    observer.observe(card)
    const composer = document.querySelector<HTMLElement>('[data-composer-box]')
    if (composer !== null) observer.observe(composer)
    const slide = document.querySelector<HTMLElement>('[data-session-slide]') ?? document.querySelector('main')
    if (slide !== null) observer.observe(slide)
    let frame = 0
    let activeTransitions = 0
    const follow = (): void => {
      sync()
      if (activeTransitions > 0) frame = requestAnimationFrame(follow)
      else frame = 0
    }
    const onTransitionStart = (): void => {
      activeTransitions += 1
      if (frame === 0) frame = requestAnimationFrame(follow)
    }
    const onTransitionDone = (): void => {
      activeTransitions = Math.max(0, activeTransitions - 1)
      sync()
    }
    window.addEventListener('resize', sync)
    document.addEventListener('transitionrun', onTransitionStart, true)
    document.addEventListener('transitionend', onTransitionDone, true)
    document.addEventListener('transitioncancel', onTransitionDone, true)
    sync()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', sync)
      document.removeEventListener('transitionrun', onTransitionStart, true)
      document.removeEventListener('transitionend', onTransitionDone, true)
      document.removeEventListener('transitioncancel', onTransitionDone, true)
      root.style.removeProperty('--approval-height')
    }
  }, [])

  const sendCustom = (): void => {
    if (custom.trim() === '') return
    onAnswer({ optionId: null, text: custom.trim() })
  }

  return (
    <div
      className="pointer-events-none fixed z-30"
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
        className="glass-surface pointer-events-auto mx-auto w-full max-w-3xl 2xl:max-w-5xl overflow-hidden rounded-xl border border-line shadow-2xl"
      >
        <header className="flex items-center justify-between gap-2.5 px-5 py-3">
          <span className="text-[14px] text-text">Question</span>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">
            ask_question
          </span>
          <button
            type="button"
            onClick={() => onAnswer({ optionId: null, text: '' })}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line text-dim transition-colors hover:border-hover hover:text-brand"
          >
            ×
          </button>
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
            Skip
          </button>
          {request.allowCustom && (
            <div className="ml-auto flex min-w-0 flex-1 items-center gap-2">
              <input
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) sendCustom()
                }}
                placeholder="Or type your own answer…"
                aria-label="Custom answer"
                className="glass-field min-w-0 flex-1 rounded-md border border-line bg-transparent px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint focus:border-hover"
              />
              <button
                type="button"
                onClick={sendCustom}
                disabled={custom.trim() === ''}
                className="rounded-md px-3 py-1.5 text-[12.5px] text-text transition-colors hover:bg-raised hover:text-brand disabled:cursor-not-allowed disabled:text-faint"
              >
                Send
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}
