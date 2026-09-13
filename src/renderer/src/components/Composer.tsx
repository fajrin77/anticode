import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEvent, JSX } from 'react'
import { useActiveSession, useSessionStore } from '../store/session'
import { ModelPicker } from './ModelPicker'
import { TodoPanel } from './TodoPanel'
import { fileTag, formatBytes, ImageViewer, openAttachment } from './Attachments'
import { modelCannotSeeImages, modelLabel, statusFor } from '@shared/ipc'
import type {
  AttachmentInfo,
  ProviderId,
  ProviderInfo,
  QueuedPrompt,
  SessionStatus
} from '@shared/ipc'
import type { MessagePart } from '../store/session'

interface ComposerProps {
  /** The whole status; the composer reads its own session's model from it. */
  status: SessionStatus | null
  providers: ProviderInfo[]
  /** A pick made here names this session, so no other tab changes model. */
  onSelectProvider: (provider: ProviderId, model: string, sessionId?: string | null) => void
  onToggleAutoApprove: (enabled: boolean) => void
  /** Fresh-session layout: the picker row for mode and folder sits below. */
  hero?: boolean
  /** Appended to the right end of the hero picker row (e.g. a search button). */
  heroExtra?: JSX.Element
}

import { CONTINUE_PROMPT, RESUME_LABEL } from '../labels'

export { CONTINUE_PROMPT, FOLLOW_UP_LABEL, PAUSE_LABEL, RESUME_LABEL } from '../labels'

/**
 * Pause found nothing running: the run ended without this window hearing of
 * it. Keeping it would leave a pause button that stops nothing, so it goes,
 * and the transcript is taken from the main process, which saw the whole run.
 */
async function letGoOfFinishedRun(sessionId: string): Promise<void> {
  const store = useSessionStore.getState()
  for (const [runId, run] of Object.entries(store.activeRuns)) {
    if (run.sessionId !== sessionId) continue
    store.settleMessage(run.messageId)
    store.setActiveRun(null, runId)
  }
  for (const [runId, run] of Object.entries(store.mirrorRuns)) {
    if (run.sessionId === sessionId) store.mirrorSettle(runId)
  }
  const snapshot = await window.anticode.getSessionSnapshot(sessionId)
  if (snapshot !== null) {
    useSessionStore.getState().importSnapshot(sessionId, snapshot.messages, snapshot.summaries)
  }
}

const NO_QUEUE: QueuedPrompt[] = []

/** Spread-based encoding blows the call stack on megabyte images. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

function Chip({
  children,
  onClick,
  active,
  disabled = false
}: {
  children: JSX.Element | string
  onClick: () => void
  active: boolean
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors ${
        disabled ? 'glass-ghost cursor-default text-dim' : active ? 'glass-control border text-text' : 'glass-ghost text-dim hover:text-brand'
      }`}
    >
      {children}
    </button>
  )
}

export function Composer({
  status: sharedStatus,
  providers,
  onSelectProvider,
  onToggleAutoApprove,
  hero = false,
  heroExtra
}: ComposerProps): JSX.Element {
  const session = useActiveSession()
  const status = sharedStatus === null ? null : statusFor(sharedStatus, session?.id)
  const savedDraft = useSessionStore((state) => state.drafts[session?.id ?? ''])
  const draft = savedDraft?.text ?? ''
  const attached = savedDraft?.attachments ?? []
  const quote = savedDraft?.quote ?? ''
  const clearQuote = (): void => {
    if (session) useSessionStore.getState().quoteInDraft(session.id, '')
  }
  const setDraft = (text: string): void => { if (session) useSessionStore.getState().updateDraft(session.id, { text }) }
  const setAttached = (next: AttachmentInfo[] | ((items: AttachmentInfo[]) => AttachmentInfo[])): void => {
    if (session) {
      const previous = useSessionStore.getState().drafts[session.id]?.attachments ?? []
      useSessionStore.getState().updateDraft(session.id, { attachments: typeof next === 'function' ? next(previous) : next })
    }
  }
  const [viewing, setViewing] = useState<{ name: string; src: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'none' | 'model' | 'mode' | 'folder'>('none')
  const [shake, setShake] = useState(false)
  const [glow, setGlow] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const activeRun = useSessionStore((state) => Object.values(state.activeRuns).find((run) => run.sessionId === session?.id) ?? null)
  const mirrorRunId = useSessionStore((state) => Object.entries(state.mirrorRuns).find(([, run]) => run.sessionId === session?.id)?.[0] ?? null)
  const addMessage = useSessionStore((state) => state.addMessage)
  const addNotice = useSessionStore((state) => state.addNotice)
  const setActiveRun = useSessionStore((state) => state.setActiveRun)
  const updateSessionConfig = useSessionStore((state) => state.updateSessionConfig)
  const isPaused = useSessionStore(
    (state) => session !== undefined && state.pausedSessions[session.id] === true
  )
  const dropLastTurn = useSessionStore((state) => state.dropLastTurn)
  const followUpMode = useSessionStore((state) => state.followUpMode)
  const setFollowUpMode = useSessionStore((state) => state.setFollowUpMode)
  const queued = useSessionStore((state) => state.queues[session?.id ?? ''] ?? NO_QUEUE)

  // Streaming is judged per session: a run elsewhere must never block this
  // session's composer or swallow its Enter key.
  const isStreaming = activeRun !== null || mirrorRunId !== null
  // A code session is only usable once it is bound to a folder; chat never needs one.
  const sessionReady =
    session !== undefined && (session.mode === 'chat' || session.projectRoot !== null)
  const folderMissing =
    status?.providerReady === true &&
    session !== undefined &&
    session.mode === 'code' &&
    session.projectRoot === null
  const blocked = status?.providerReady !== true
    ? (status?.blockedReason ?? null)
    : sessionReady
      ? null
      : 'This code session is not connected to a project folder'
  // A prompt typed while the session is working is sent too: it joins the run
  // in progress as a follow-up rather than waiting for it to end.
  const canSend = draft.trim() !== '' && blocked === null
  /** Working, with something typed: the button sends it rather than pausing. */
  const steering = isStreaming && !isPaused && draft.trim() !== ''
  /**
   * Paused, with nothing typed: the button picks the work back up. It wears a
   * play mark of its own — as a send arrow it read as sending an empty prompt.
   * Paused with something typed, it sends that instead.
   */
  const resuming = isPaused && !isStreaming && draft.trim() === ''
  const imageWarning = attached.some((item) => item.kind === 'image') && modelCannotSeeImages(status?.model)

  // A one-line prompt stays compact; wrapped lines grow the same glass card
  // up to a useful ceiling, after which the field scrolls internally.
  useLayoutEffect(() => {
    const field = promptRef.current
    if (field === null) return
    field.style.height = '0px'
    field.style.height = `${Math.min(field.scrollHeight, 192)}px`
    field.style.overflowY = field.scrollHeight > 192 ? 'auto' : 'hidden'
  }, [draft])

  // The established-session composer floats over the scrolling transcript.
  // Its live height becomes bottom padding on that transcript, so attachments
  // may grow without hiding the final reply and no opaque footer is needed.
  useLayoutEffect(() => {
    if (hero) return
    const layer = layerRef.current
    const zone = layer?.closest<HTMLElement>('[data-drop-zone]')
    if (layer === null || zone === null || zone === undefined) return
    const root = document.documentElement
    const sync = (): void => {
      const height = layer.getBoundingClientRect().height
      zone.style.setProperty('--desktop-composer-height', `${height}px`)
      // The approval card floats at window level, just above this composer.
      if (height > 0) root.style.setProperty('--composer-offset', `${height}px`)
      else root.style.removeProperty('--composer-offset')
    }
    const observer = new ResizeObserver(sync)
    observer.observe(layer)
    sync()
    return () => {
      observer.disconnect()
      zone.style.removeProperty('--desktop-composer-height')
      root.style.removeProperty('--composer-offset')
    }
  }, [hero])


  useEffect(() => {
    function onOutside(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) setMenu('none')
    }
    // Escape dismisses the model/mode menu, matching the approval modal and
    // the model picker; without it the only way out was a click elsewhere.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenu('none')
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  async function collect(promise: Promise<AttachmentInfo[]>): Promise<void> {
    setError(null)
    try {
      const added = await promise
      setAttached((current) => [...current, ...added])
    } catch (failure) {
      setError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }

  /** A screenshot on the clipboard has no file on disk, so its bytes travel. */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files) {
      void collect(
        file
          .arrayBuffer()
          .then((buffer) =>
            window.anticode.addAttachmentData(
              file.name === '' ? `pasted-${Date.now()}.png` : file.name,
              toBase64(buffer)
            )
          )
      )
    }
  }


  // Blocked because anticode has no folder: shake the composer and glow the
  // Choose folder button until a folder is picked.
  function flagMissingFolder(): void {
    setShake(true)
    setGlow(true)
    window.setTimeout(() => setShake(false), 450)
  }

  useEffect(() => {
    if (session?.projectRoot !== null && session?.projectRoot !== undefined) setGlow(false)
  }, [session?.projectRoot])

  useEffect(() => {
    if (quote === '' || session === undefined) return
    function onOutside(event: MouseEvent): void {
      const target = event.target as HTMLElement | null
      // The Balas button lives outside the composer, and its own mousedown is
      // what created this quote — it must not also dismiss it.
      if (target?.closest('[data-reply-button]') != null) return
      if (!boxRef.current?.contains(target)) clearQuote()
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') clearQuote()
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [quote, session?.id])

  // Pause stops the run mid-task; resume sends a continuation instruction so
  // the agent picks up exactly where its history left off. The pause itself
  // is the main process's: the run starting there is what ends it, for this
  // window and the phone alike, and a refused resume leaves it standing.
  async function resume(): Promise<void> {
    if (session === undefined || isStreaming) return
    const runId = crypto.randomUUID()
    const previous = [...useSessionStore.getState().sessions.find((entry) => entry.id === session.id)?.messages ?? []]
      .reverse()
      .find((message) => message.role === 'assistant' && message.parts.some((part) => part.kind !== 'notice'))
    const messageId = previous?.id ?? crypto.randomUUID()
    addNotice(session.id, RESUME_LABEL)
    if (previous === undefined) addMessage({ id: messageId, role: 'assistant', parts: [], pending: true })
    else useSessionStore.getState().reopenMessage(messageId)
    setActiveRun({ runId, messageId, sessionId: session.id, startedAt: Date.now() })
    try {
      await window.anticode.sendPrompt({
        sessionId: session.id,
        runId,
        prompt: CONTINUE_PROMPT,
        attachmentIds: []
      })
    } catch (failure) {
      setError((failure as Error).message)
      useSessionStore.getState().appendText(session.id, messageId, (failure as Error).message)
      useSessionStore.getState().settleMessage(messageId)
      setActiveRun(null, runId)
    }
  }

  // Pausing because the prompt was wrong: take the exchange back out of the
  // history and put the prompt in the box, ready to be fixed and sent again.
  async function revert(): Promise<void> {
    if (session === undefined) return
    try {
      const prompt = await window.anticode.revertLastTurn(session.id)
      dropLastTurn(session.id)
      if (prompt !== null) setDraft(prompt)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  /** A queued prompt comes back into the box to be changed; its place in line is given up. */
  async function pullBack(item: QueuedPrompt): Promise<void> {
    if (session === undefined) return
    const taken = await window.anticode.unqueuePrompt(session.id, item.id)
    if (taken === null) return
    const current = useSessionStore.getState().drafts[session.id]?.text ?? ''
    setDraft(current.trim() === '' ? taken.text : `${current}\n\n${taken.text}`)
    if (taken.attachments.length > 0) {
      void collect(window.anticode.addAttachments(taken.attachments.map((file) => file.path)))
    }
    promptRef.current?.focus()
  }

  /**
   * `alternate` is Cmd/Ctrl+Enter: while a run works it does the other of
   * steer and queue, so neither needs the chip to be flipped first.
   */
  async function send(alternate = false): Promise<void> {
    const prompt = draft.trim()
    if (!canSend || session === undefined) {
      if (
        status?.providerReady === true &&
        session !== undefined &&
        session.mode === 'code' &&
        session.projectRoot === null
      ) {
        flagMissingFolder()
      }
      return
    }

    const attachmentIds = attached.map((item) => item.id)
    // A quoted passage travels with the prompt so the model answers the part
    // that was selected, and shows in the transcript for the same reason.
    const shown = quote === '' ? prompt : `${quote.replace(/^/gm, '> ')}\n\n${prompt}`

    // The session is working: this joins that run. The main process tells
    // every viewer — this one included — and the transcript is drawn from
    // that, so nothing is drawn here that the phone would not also see.
    if (isStreaming) {
      const kept = { text: draft, attachments: attached, quote }
      setDraft('')
      setAttached([])
      clearQuote()
      const queue = (followUpMode === 'queue') !== alternate
      try {
        const request = { sessionId: session.id, runId: crypto.randomUUID(), prompt: shown, attachmentIds }
        // A queued prompt waits in the main process, shown above the box on
        // every screen, and goes out as its own run once this one finishes.
        if (queue) await window.anticode.queuePrompt(request)
        else await window.anticode.sendPrompt(request)
      } catch (failure) {
        setError((failure as Error).message)
        useSessionStore.getState().updateDraft(session.id, kept)
      }
      return
    }
    // The files are drawn as pictures and cards; only the typed prompt is text.
    const parts: MessagePart[] =
      attached.length > 0
        ? [
            { kind: 'attachments', items: attached.map(({ id: _id, preview: _preview, ...ref }) => ref) },
            { kind: 'text', text: shown }
          ]
        : [{ kind: 'text', text: shown }]

    setDraft('')
    setAttached([])
    clearQuote()
    // A new prompt ends a pause as surely as Continue does; the main process
    // clears it when the run begins, and tells every viewer.
    const userMessageId = crypto.randomUUID()
    addMessage({ id: userMessageId, role: 'user', parts, pending: false })

    const messageId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    addMessage({ id: messageId, role: 'assistant', parts: [], pending: true })
    setActiveRun({ runId, messageId, sessionId: session.id, startedAt: Date.now() })

    try {
    // The first prompt finalises a fresh session's binding: the main process
    // session is (re)created with the mode and folder chosen in the hero.
    if (session.messages.length === 0) {
      await window.anticode.createSession({
        sessionId: session.id,
        mode: session.mode,
        workspaceRoot: session.mode === 'code' ? session.projectRoot : null
      })
    }

      const outcome = await window.anticode.sendPrompt({ sessionId: session.id, runId, prompt: shown, attachmentIds })
      // A run started elsewhere a moment ago took this as a follow-up; the
      // steer event draws it, so what was drawn here for a new run goes.
      if (outcome.steered) {
        useSessionStore.getState().removeMessages(session.id, [userMessageId, messageId])
        setActiveRun(null, runId)
      }
    } catch (failure) {
      // A refused send must not leave a ghost run blocking the composer.
      setError((failure as Error).message)
      useSessionStore.getState().appendText(session.id, messageId, (failure as Error).message)
      useSessionStore.getState().settleMessage(messageId)
      setActiveRun(null, runId)
    }
  }

  const shortModel = modelLabel(status)
  // Code sessions always name the repo they are bound to, right in the composer.
  const folder =
    session?.mode === 'code' && session.projectRoot !== null
      ? (session.projectRoot.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? session.projectRoot)
      : null

  return (
    <div
      ref={layerRef}
      data-composer-layer
      className={hero ? 'shrink-0 px-10' : 'absolute inset-x-0 bottom-0 z-20 px-10 pb-6'}
    >
      {viewing !== null && (
        <ImageViewer name={viewing.name} src={viewing.src} onClose={() => setViewing(null)} />
      )}
      <div className="mx-auto max-w-3xl" ref={boxRef}>
        {blocked !== null && !(hero && folderMissing) && (
          <div className="mb-2 px-1 text-[12.5px] text-dim">{blocked}</div>
        )}
        {error !== null && <div className="mb-2 px-1 text-[12.5px] text-del">{error}</div>}
        {imageWarning && (
          <div role="status" className="mb-2 px-1 text-[12.5px] text-del">
            {status?.model} is a text-only model and cannot inspect the attached image. Choose a vision model before sending.
          </div>
        )}

        {/* The menus sit beside the glass card, not inside it: an element with a
            backdrop-filter is the backdrop for anything inside it, so a menu in
            there blurred only the card's own empty top and the transcript showed
            through it unblurred. Out here their blur reaches the page. */}
        <div className="relative">
          {menu === 'model' && (
            <ModelPicker
              status={status}
              providers={providers}
              onSelect={(provider, model) => {
                onSelectProvider(provider, model, session?.id ?? null)
                if (model !== '') setMenu('none')
              }}
              onClose={() => setMenu('none')}
            />
          )}

          {menu === 'mode' && (
            <div className="menu-glass absolute bottom-full left-3 z-20 mb-2 w-72 rounded-xl border p-1.5">
              {[
                { value: false, name: 'Default', hint: 'Ask before changing anything' },
                { value: true, name: 'Auto', hint: 'Run everything without asking' }
              ].map((option) => (
                <button
                  key={option.name}
                  type="button"
                  onClick={() => {
                    onToggleAutoApprove(option.value)
                    setMenu('none')
                  }}
                  className={`group w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-hover hover:text-brand ${
                    status?.autoApprove === option.value ? 'text-text' : 'text-dim'
                  }`}
                >
                  <div className="text-[12.5px]">{option.name}</div>
                  <div className="text-[11px] text-faint transition-colors group-hover:text-brand">
                    {option.hint}
                  </div>
                </button>
              ))}
              <p className="px-2 py-1.5 text-[11px] text-faint">
                Turn Auto off to be asked again.
              </p>
            </div>
          )}

          {!hero && session !== undefined && <TodoPanel sessionId={session.id} messages={session.messages} working={isStreaming && !isPaused} />}

          {queued.length > 0 && (
            <div className="mb-2 flex flex-col gap-1" data-queue>
              {queued.map((item, index) => (
                <div
                  key={item.id}
                  className="composer-glass flex items-center gap-2.5 rounded-xl border border-line px-3 py-1.5 text-[12.5px]"
                >
                  <span className="shrink-0 tabular-nums text-faint">queued {index + 1}</span>
                  <button
                    type="button"
                    onClick={() => void pullBack(item)}
                    title="Take it off the queue and edit it"
                    className="min-w-0 flex-1 truncate text-left text-dim transition-colors hover:text-brand"
                  >
                    {item.text}
                  </button>
                  {item.attachments.length > 0 && (
                    <span className="shrink-0 text-[11px] text-faint">
                      +{item.attachments.length} {item.attachments.length === 1 ? 'file' : 'files'}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="Remove from queue"
                    onClick={() => void window.anticode.unqueuePrompt(session?.id ?? '', item.id)}
                    className="shrink-0 text-faint transition-colors hover:text-brand"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={`composer-glass relative overflow-visible rounded-[22px] border border-line transition-colors ${
              shake ? 'animate-shake' : ''
            }`}
          >
            {quote !== '' && (
              <div className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-line bg-bg/35 px-3 py-2">
                <span className="mt-0.5 w-0.5 self-stretch rounded bg-brand" aria-hidden />
                <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-dim">
                  <span className="mb-0.5 block text-[11px] text-faint">Membalas</span>
                  <span className="line-clamp-3 whitespace-pre-wrap">{quote}</span>
                </span>
                <button
                  type="button"
                  onClick={clearQuote}
                  aria-label="Remove quote"
                  className="shrink-0 text-faint transition-colors hover:text-brand"
                >
                  ×
                </button>
              </div>
            )}

            {attached.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {attached.map((item) => (
                  <span
                    key={item.id}
                    className="group/chip relative flex min-w-0 max-w-64 items-center gap-2 rounded-xl border border-line bg-bg/35 p-1.5 pr-7 text-[12px] text-dim"
                  >
                    {item.thumbnail !== null ? (
                      // Staged is not sent: a screenshot is checked here, at full
                      // size, the same way it can be once it is in the transcript.
                      <button
                        type="button"
                        title={`View ${item.name}`}
                        onClick={() => openAttachment(item, setViewing)}
                        className="shrink-0 overflow-hidden rounded-lg ring-brand transition-shadow hover:ring-1"
                      >
                        <img
                          src={item.thumbnail}
                          alt={item.name}
                          className="h-12 w-12 object-cover"
                        />
                      </button>
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-raised/80 text-[9px] font-semibold tracking-wide text-faint">
                        {fileTag(item)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => openAttachment(item, setViewing)}
                      className="group/name min-w-0 text-left"
                    >
                      <span className="block truncate text-text transition-colors group-hover/name:text-brand">{item.name}</span>
                      <span className="block text-[11px] text-faint">{fileTag(item)} · {formatBytes(item.size)}</span>
                    </button>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => { void window.anticode.releaseAttachments([item.id]); setAttached((c) => c.filter((a) => a.id !== item.id)) }}
                      className="absolute top-1 right-1.5 text-faint transition-colors hover:text-brand"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              ref={promptRef}
              rows={1}
              value={draft}
              placeholder={
                isStreaming && !isPaused
                  ? followUpMode === 'queue'
                    ? 'Queue the next prompt…'
                    : 'Add to the task…'
                  : !hero && session?.mode === 'code'
                    ? 'Tell anticode what to change…'
                    : "Don't work today, just vibes."
              }
              onChange={(event) => setDraft(event.target.value)}
              onPaste={onPaste}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send(event.metaKey || event.ctrlKey)
                }
              }}
              data-composer
              className="block min-h-11 max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-5 text-text outline-none placeholder:text-faint"
            />

            <div className="flex items-center gap-1 px-2.5 pb-2.5">
              <button
                type="button"
                title="Attach files"
                onClick={() => void collect(window.anticode.chooseAttachments())}
                className="glass-ghost flex h-7 w-7 items-center justify-center rounded-md text-dim hover:text-brand"
              >
                +
              </button>

              {folder !== null && !hero && (
                <span
                  title={session?.projectRoot ?? undefined}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-dim"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
                  </svg>
                  <span className="max-w-40 truncate font-mono">{folder}</span>
                </span>
              )}

              {/* Once a code session has messages the hero is gone, and with it
                  the only way to attach a folder — a session that reached this
                  state had no way out. The button lives here too. */}
              {folderMissing && !hero && session !== undefined && (
                <button
                  type="button"
                  title="Choose a project folder"
                  onClick={() => {
                    void window.anticode.chooseWorkspace().then((next) => {
                      if (next.workspaceRoot !== null) {
                        updateSessionConfig(session.id, {
                          mode: 'code',
                          projectRoot: next.workspaceRoot
                        })
                      }
                    })
                  }}
                  className={`flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12.5px] transition-colors ${
                    glow ? 'animate-glow text-dim hover:text-brand' : 'text-dim hover:text-brand'
                  }`}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
                  </svg>
                  Choose folder
                </button>
              )}

              {/* Under Rotate usage the model is not picked per session, but the
                  group every session rotates over is — so with groups made,
                  the chip opens on that choice. */}
              <Chip disabled={status?.rotationEnabled === true && (status.rotationGroups ?? []).length === 0} onClick={() => setMenu(menu === 'model' ? 'none' : 'model')} active={menu === 'model'}>
                <span className="max-w-56 truncate font-mono">{shortModel}</span>
              </Chip>

              <Chip onClick={() => setMenu(menu === 'mode' ? 'none' : 'mode')} active={menu === 'mode'}>
                {status?.autoApprove === true ? 'Auto' : 'Default'}
              </Chip>

              {/* Only while a run works: what a prompt sent now does. Both words
                  are laid out at once so flipping never moves the row. */}
              {isStreaming && !isPaused && (
                <button
                  type="button"
                  onClick={() => setFollowUpMode(followUpMode === 'queue' ? 'steer' : 'queue')}
                  title={
                    followUpMode === 'queue'
                      ? 'Enter queues the prompt for after this run · ⌘/Ctrl+Enter adds it to this run'
                      : 'Enter adds the prompt to this run · ⌘/Ctrl+Enter queues it for after'
                  }
                  className="glass-ghost grid rounded-md px-2 py-1 text-[12.5px] text-dim hover:text-brand"
                >
                  <span className={`col-start-1 row-start-1 ${followUpMode === 'steer' ? '' : 'invisible'}`}>steer</span>
                  <span className={`col-start-1 row-start-1 ${followUpMode === 'queue' ? '' : 'invisible'}`}>queue</span>
                </button>
              )}

              <div className="flex-1" />

              {isPaused && !isStreaming && (
                <button
                  type="button"
                  onClick={() => void revert()}
                  title="Take back the last prompt and edit it"
                  className="glass-ghost mr-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-dim hover:text-brand"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <path d="M6 4.5L2.5 8 6 11.5" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M2.5 8h7a4 4 0 0 1 0 8H8" strokeLinecap="round" />
                  </svg>
                  Revert
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  if (steering) {
                    void send()
                    return
                  }
                  if (isStreaming && !isPaused) {
                    // The main process pauses whichever run is working in this
                    // session — started here or on the phone — and tells every
                    // viewer, this one included, which draws the marker.
                    const id = session?.id ?? ''
                    void window.anticode.pauseSession(id).then((paused) => {
                      if (!paused) void letGoOfFinishedRun(id)
                    })
                    return
                  }
                  if (resuming) {
                    void resume()
                    return
                  }
                  void send()
                }}
                // Nothing typed and nothing to resume or pause: nothing to press.
                // Typed but blocked stays live only when a folder is what is
                // missing, so pressing it points at the folder button.
                disabled={
                  (isPaused && isStreaming) ||
                  (!isStreaming &&
                    !resuming &&
                    (draft.trim() === '' || (!canSend && !folderMissing)))
                }
                aria-label={resuming ? 'Continue' : steering ? (followUpMode === 'queue' ? 'Queue' : 'Send') : isStreaming ? 'Pause' : 'Send'}
                className={`flex h-8 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:text-faint ${
                  resuming
                    ? 'gap-1.5 bg-brand px-3 text-bg hover:bg-brand-strong'
                    : 'glass-ghost w-8 text-text hover:text-brand'
                }`}
              >
                {resuming ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                      <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
                    </svg>
                    <span className="text-[12.5px]">Continue</span>
                  </>
                ) : isStreaming && !isPaused && !steering ? (
                  <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {hero && session !== undefined && (
          <div className="mt-4 flex items-center justify-center gap-2">
            {heroExtra}
            <div className="flex rounded-lg border border-line p-0.5">
              {(['chat', 'code'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() =>
                    updateSessionConfig(session.id, {
                      mode,
                      projectRoot: mode === 'chat' ? null : session.projectRoot
                    })
                  }
                  className={`rounded-md px-4 py-1.5 text-[13px] transition-colors ${
                    session.mode === mode
                      ? 'bg-brand font-medium text-bg'
                      : 'text-dim hover:text-brand'
                  }`}
                >
                  {mode === 'chat' ? 'antichat' : 'anticode'}
                </button>
              ))}
            </div>

            {session.mode === 'code' && (
              <button
                type="button"
                title={session.projectRoot ?? 'Choose a project folder'}
                onClick={() => {
                  void window.anticode.chooseWorkspace().then((next) => {
                    if (next.workspaceRoot !== null) {
                      updateSessionConfig(session.id, {
                        mode: 'code',
                        projectRoot: next.workspaceRoot
                      })
                    }
                  })
                }}
                className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                  glow && session.projectRoot === null
                    ? 'animate-glow text-dim hover:text-brand'
                    : 'border-line text-dim hover:text-brand'
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
                </svg>
                <span className="max-w-44 truncate">
                  {session.projectRoot !== null
                    ? (session.projectRoot.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? 'folder')
                    : 'Choose folder'}
                </span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
