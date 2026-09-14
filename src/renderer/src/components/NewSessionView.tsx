import { DASHBOARD_DRAFT, stageDraftAttachments, useAttachmentJobs, fileAttachmentJob } from '../draftAttachments'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { modelLabel } from '@shared/ipc'
import type { AttachmentInfo, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'
import { useSessionStore } from '../store/session'
import type { MessagePart, Session } from '../store/session'
import { Composer } from './Composer'
import { fileTag, formatBytes } from './Attachments'
import { ModelPicker } from './ModelPicker'
import { SessionRow } from './SessionRow'
import chatLogo from '../assets/open-chat-logo.svg'

interface NewSessionViewProps {
  /** The fresh draft being edited, when the dashboard was opened via "+". */
  session: Session | undefined
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string, sessionId?: string | null) => void
  onToggleAutoApprove: (enabled: boolean) => void
  onSelectSession: (id: string) => void
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

/**
 * The session-less composer for the pure dashboard: the mode and folder live
 * in local state, and the session (with its tab) only comes into existence
 * when the first prompt is actually sent.
 */
function DashboardComposer({
  status,
  providers,
  onSelectProvider,
  onToggleAutoApprove,
  extra,
  fill
}: {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string, sessionId?: string | null) => void
  onToggleAutoApprove: (enabled: boolean) => void
  extra: JSX.Element
  /** { text, pulse } — a pulse bump re-applies the same preset text. */
  fill: { text: string; pulse: number }
}): JSX.Element {
  const savedDraft = useSessionStore(state => state.drafts[DASHBOARD_DRAFT])
  const mode = savedDraft?.mode ?? 'code'
  const folder = savedDraft?.folder ?? null
  const draft = savedDraft?.text ?? ''
  const attached = savedDraft?.attachments ?? []
  const pending = useAttachmentJobs(state => state.pending[DASHBOARD_DRAFT] ?? 0)
  const attachmentErrors = savedDraft?.attachmentErrors ?? []
  const update = useSessionStore.getState().updateDraft
  const setMode = (mode: 'chat' | 'code') => update(DASHBOARD_DRAFT, { mode })
  const setFolder = (folder: string | null) => update(DASHBOARD_DRAFT, { folder })
  const setDraft = (text: string) => update(DASHBOARD_DRAFT, { text })
  const setAttached = (next: AttachmentInfo[] | ((items: AttachmentInfo[]) => AttachmentInfo[])) => {
    const current = useSessionStore.getState().drafts[DASHBOARD_DRAFT]?.attachments ?? []
    update(DASHBOARD_DRAFT, { attachments: typeof next === 'function' ? next(current) : next })
  }
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'none' | 'model' | 'mode'>('none')
  const [shake, setShake] = useState(false)
  const [glow, setGlow] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const openSession = useSessionStore((state) => state.openSession)
  const addMessage = useSessionStore((state) => state.addMessage)
  const setActiveRun = useSessionStore((state) => state.setActiveRun)

  // Local guard only: a run elsewhere must never stop this hero from
  // minting a brand-new session.
  const [sending, setSending] = useState(false)
  const ready =
    status?.providerReady === true && (mode === 'chat' || folder !== null)
  const canSend = draft.trim() !== '' && !sending && ready && pending === 0 && attachmentErrors.length === 0

  useLayoutEffect(() => {
    const field = promptRef.current
    if (field === null) return
    field.style.height = '0px'
    field.style.height = `${Math.min(field.scrollHeight, 192)}px`
    field.style.overflowY = field.scrollHeight > 192 ? 'auto' : 'hidden'
  }, [draft])

  // A preset click lands here: fill.text carries the prompt, fill.pulse makes
  // re-applying the same preset still register as a change.
  useEffect(() => {
    if (fill.pulse === 0) return
    setDraft(fill.text)
  }, [fill.pulse, fill.text])

  // Blocked send with anticode and no folder: shake the composer and glow the
  // Choose folder button until a folder is picked.
  function flagMissingFolder(): void {
    setShake(true)
    setGlow(true)
    window.setTimeout(() => setShake(false), 450)
  }

  useEffect(() => {
    if (folder !== null) setGlow(false)
  }, [folder])

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

  function collect(job: () => Promise<AttachmentInfo[]>): void {
    void stageDraftAttachments(DASHBOARD_DRAFT, [job])
  }

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (sending || (useAttachmentJobs.getState().pending[DASHBOARD_DRAFT] ?? 0) > 0 || (useSessionStore.getState().drafts[DASHBOARD_DRAFT]?.attachmentErrors?.length ?? 0) > 0) return
    if (!canSend) {
      if (status?.providerReady === true && mode === 'code' && folder === null) {
        flagMissingFolder()
      }
      return
    }
    setSending(true)

    const attachmentIds = attached.map((item) => item.id)
    const parts: MessagePart[] = attached.length > 0
      ? [
          { kind: 'attachments', items: attached.map(({ id: _id, preview: _preview, ...ref }) => ref) },
          { kind: 'text', text: prompt }
        ]
      : [{ kind: 'text', text: prompt }]

    // This is the moment the session comes into existence — bound straight to
    // the mode and folder chosen here.
    const sessionId = openSession(mode, folder)


    setDraft('')
    setAttached([])
    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts,
      pending: false
    })
    const messageId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    addMessage({ id: messageId, role: 'assistant', parts: [], pending: true })
    setActiveRun({ runId, messageId, sessionId, startedAt: Date.now() })

    try {
      await window.anticode.createSession({ sessionId, mode, workspaceRoot: mode === 'code' ? folder : null })
      await window.anticode.sendPrompt({ sessionId, runId, prompt, attachmentIds })
    } catch (failure) {
      // A refused send must not leave a ghost run blocking the hero.
      setError((failure as Error).message)
      useSessionStore.getState().updateDraft(sessionId, { text: prompt, attachments: attached })
      useSessionStore.getState().appendText(sessionId, messageId, (failure as Error).message)
      useSessionStore.getState().settleMessage(messageId)
      setActiveRun(null, runId)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="shrink-0 px-10">
      <div className="mx-auto max-w-3xl" ref={boxRef}>
        {error !== null && <div className="mb-2 px-1 text-[12.5px] text-del">{error}</div>}
        {pending > 0 && <div role="status" className="mb-2 px-1 text-[12.5px] text-dim">Preparing attachments… ({pending})</div>}
        {attachmentErrors.length > 0 && <div role="alert" className="mb-2 px-1 text-[12.5px] text-del">
          {attachmentErrors.map((message, index) => <div key={index}>{message}</div>)}
          <button type="button" onClick={() => update(DASHBOARD_DRAFT, { attachmentErrors: [] })} className="mt-1 text-dim transition-colors hover:text-brand">Dismiss attachment errors</button>
        </div>}


        {/* Menus beside the glass card, not inside it, so their blur reaches
            the page behind (see Composer). */}
        <div className="relative">
          {menu === 'model' && (
            <ModelPicker
              status={status}
              providers={providers}
              onSelect={(provider, model) => {
                onSelectProvider(provider, model)
                if (model !== '') setMenu('none')
              }}
              onClose={() => setMenu('none')}
            />
          )}

          {menu === 'mode' && (
            <div className="menu-glass absolute bottom-full left-3 z-20 mb-2 w-72 rounded-xl border p-1.5">
              {[
                { value: false, name: 'Default', hint: 'Ask before changing anything' },
                { value: true, name: 'Auto', hint: 'Skip prompts for medium risk' }
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
                Auto still asks before high-risk actions. Saved permissions apply in Default.
              </p>
            </div>
          )}

          <div
            className={`composer-glass relative rounded-[22px] border transition-colors ${
              menu !== 'none' ? 'border-dim' : 'border-line'
            } ${shake ? 'animate-shake' : ''}`}
          >

            {attached.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {attached.map((item) => (
                  <span
                    key={item.id}
                    className="relative flex min-w-0 max-w-64 items-center gap-2 rounded-xl border border-line bg-bg/35 p-1.5 pr-7 text-[12px] text-dim"
                  >
                    {item.thumbnail !== null ? (
                      <img src={item.thumbnail} alt={item.name} className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-raised/80 text-[9px] font-semibold tracking-wide text-faint">
                        {fileTag(item)}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-text">{item.name}</span>
                      <span className="block text-[11px] text-faint">{fileTag(item)} · {formatBytes(item.size)}</span>
                    </span>
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
              placeholder="Don't work today, just vibes."
              onChange={(event) => setDraft(event.target.value)}
              onPaste={event => {
                const files = Array.from(event.clipboardData.files)
                if (files.length) {
                  event.preventDefault()
                  void stageDraftAttachments(DASHBOARD_DRAFT, files.map(fileAttachmentJob))
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void send()
                }
              }}
              className="block min-h-11 max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-5 text-text outline-none placeholder:text-faint"
            />

            <div className="flex items-center gap-1 px-2.5 pb-2.5">
              <button
                type="button"
                title="Attach files"
                onClick={() => collect(() => window.anticode.chooseAttachments())}
                className="glass-ghost flex h-7 w-7 items-center justify-center rounded-md text-dim hover:text-brand"
              >
                +
              </button>

              {/* Under Rotate usage the model is not picked per session, but the
                  group every session rotates over is — so with groups made,
                  the chip opens on that choice. */}
              <Chip disabled={status?.rotationEnabled === true && (status.rotationGroups ?? []).length === 0} onClick={() => setMenu(menu === 'model' ? 'none' : 'model')} active={menu === 'model'}>
                <span className="max-w-56 truncate font-mono">
                  {modelLabel(status)}
                </span>
              </Chip>

              <Chip onClick={() => setMenu(menu === 'mode' ? 'none' : 'mode')} active={menu === 'mode'}>
                {status?.autoApprove === true ? 'Auto' : 'Default'}
              </Chip>

              <div className="flex-1" />

              {/* Right of the spacer: appearing as words are typed, it pushes
                  nothing but itself — the chips on the left stay put. */}
              {draft.trim() !== '' && (
                <button
                  type="button"
                  title="Save this prompt as a reusable preset"
                  onClick={() => {
                    const name = draft.trim().split('\n')[0]!.slice(0, 24) || 'Preset'
                    useSessionStore.getState().savePreset(name, draft.trim())
                  }}
                  className="glass-ghost flex h-7 items-center justify-center rounded-md px-2 text-[11.5px] text-dim transition-colors hover:text-brand"
                >
                  Save preset
                </button>
              )}

              <button
                type="button"
                onClick={() => void send()}
                // An empty box has nothing to send, so the arrow is dead rather
                // than pressable-and-silent. With words typed it stays live even
                // without a folder, so pressing it shows what is missing.
                disabled={
                  sending || pending > 0 || attachmentErrors.length > 0 ||
                  draft.trim() === '' ||
                  (!ready && !(status?.providerReady === true && mode === 'code' && folder === null))
                }
                aria-label={sending ? 'Sending' : 'Send'}
                className="glass-ghost flex h-8 w-8 items-center justify-center rounded-lg text-text hover:text-brand disabled:cursor-not-allowed disabled:text-faint"
              >
                {sending ? (
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

        <div className="mt-4 flex items-center justify-center gap-2">
          {extra}
          <div className="flex rounded-lg border border-line p-0.5">
            {(['chat', 'code'] as const).map((value) => (
              <button
                key={value}
                type="button"
                title={value === 'chat' ? 'Documents and downloads; use anticode for terminal and browser tasks' : 'Files, terminal and session browser tools'}
                onClick={() => setMode(value)}
                className={`rounded-md px-4 py-1.5 text-[13px] transition-colors ${
                  mode === value
                    ? 'bg-brand font-medium text-bg'
                    : 'text-dim hover:text-brand'
                }`}
              >
                {value === 'chat' ? 'antichat' : 'anticode'}
              </button>
            ))}
          </div>

          {mode === 'code' && (
            <button
              type="button"
              title={folder ?? 'Choose a project folder'}
              onClick={() => {
                void window.anticode.chooseWorkspace().then((next) => {
                  if (next.workspaceRoot !== null) setFolder(next.workspaceRoot)
                })
              }}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] transition-colors ${
                glow && folder === null
                  ? 'animate-glow text-dim hover:text-brand'
                  : 'border-line text-dim hover:text-brand'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1.5 4.2A1.2 1.2 0 0 1 2.7 3h3l1.4 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v6A1.2 1.2 0 0 1 12.3 13H2.7a1.2 1.2 0 0 1-1.2-1.2z" />
              </svg>
              <span className="max-w-44 truncate">
                {folder !== null
                  ? (folder.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? 'folder')
                  : 'Choose folder'}
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SessionColumn({
  title,
  sessions,
  query,
  onSelect,
  onDelete,
  onDuplicate,
  runningIds
}: {
  title: string
  sessions: Session[]
  query: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  runningIds: Set<string>
}): JSX.Element {
  const needle = query.trim().toLowerCase()
  const visible = sessions.filter((session) => {
    if (needle === '') return true
    const transcript = session.messages
      .flatMap((message) => message.parts)
      .map((part) => {
        if (part.kind === 'text' || part.kind === 'notice') return part.text
        if (part.kind === 'tool') return `${part.name} ${part.output}`
        if (part.kind === 'attachments') return part.items.map((item) => item.name).join(' ')
        return ''
      })
      .join(' ')
      .toLowerCase()
    return session.title.toLowerCase().includes(needle) || transcript.includes(needle)
  })

  return (
    <div className="min-w-0">
      <div className="mb-2 px-3 text-[12.5px] text-dim">{title}</div>
      <div className="glass-surface max-h-60 overflow-y-auto rounded-xl border border-line-soft">
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-faint">No sessions yet</p>
        ) : (
          visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onSelect={onSelect}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              spinning={runningIds.has(session.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * The dashboard: wordmark and composer centred, the two session lists below.
 * When `session` is set it is a fresh draft from the "+" button and the bound
 * composer takes over; otherwise the session-less dashboard composer is used
 * and nothing is created until the first prompt is sent.
 */
export function NewSessionView({
  session,
  status,
  providers,
  onSelectProvider,
  onToggleAutoApprove,
  onSelectSession
}: NewSessionViewProps): JSX.Element {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [fillText, setFillText] = useState('')
  const [fillPulse, setFillPulse] = useState(0)
  const sessions = useSessionStore((state) => state.sessions)
  const deleteSession = useSessionStore((state) => state.deleteSession)
  const duplicateSession = useSessionStore((state) => state.duplicateSession)
  const presets = useSessionStore((state) => state.presets)
  const deletePreset = useSessionStore((state) => state.deletePreset)
  const activeRuns = useSessionStore((state) => state.activeRuns)
  const mirrorRuns = useSessionStore((state) => state.mirrorRuns)

  // Deleting wipes the session everywhere: cancel its run if one is live,
  // free the main-process side, then drop it from the store.
  function removeSession(id: string): void {
    for (const run of Object.values(activeRuns)) if (run.sessionId === id) void window.anticode.cancelRun(run.runId)
    void window.anticode.closeSession(id)
    deleteSession(id)
  }

  /** A preset fills the dashboard composer; Enter then sends it. */
  function usePreset(preset: { name: string; prompt: string }): void {
    setFillText(preset.prompt)
    setFillPulse((value) => value + 1)
  }

  // Only sessions that actually have a conversation are listed — fresh
  // drafts (zero messages) never appear here. The previously active session
  // must stay visible: viewing the dashboard does not deselect it.
  const listed = useMemo(
    () => sessions.filter((item) => item.messages.length > 0),
    [sessions]
  )
  const chatSessions = listed.filter((item) => item.mode === 'chat')
  const codeSessions = listed.filter((item) => item.mode === 'code')
  const runningIds = new Set<string>([
    ...Object.values(activeRuns).map((run) => run.sessionId),
    ...Object.values(mirrorRuns).map((entry) => entry.sessionId)
  ])

  const searchButton = (
    <button
      type="button"
      onClick={() => {
        setSearchOpen((value) => !value)
        setQuery('')
      }}
      title="Search sessions"
      className={`glass-ghost flex h-9 w-9 items-center justify-center rounded-lg hover:text-brand ${
        searchOpen ? 'text-brand' : 'text-dim'
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="7" cy="7" r="4.4" />
        <path d="M10.4 10.4L14 14" strokeLinecap="round" />
      </svg>
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-[0.7]" />
      <div className="flex justify-center px-10">
        <img src={chatLogo} alt="anticode" className="w-96 opacity-90" />
      </div>
      <div className="pt-8">
        {session !== undefined ? (
          <Composer
            hero
            heroExtra={searchButton}
            status={status}
            providers={providers}
            onSelectProvider={onSelectProvider}
            onToggleAutoApprove={onToggleAutoApprove}
          />
        ) : (
          <DashboardComposer
            status={status}
            providers={providers}
            onSelectProvider={onSelectProvider}
            onToggleAutoApprove={onToggleAutoApprove}
            extra={searchButton}
            fill={{ text: fillText, pulse: fillPulse }}
          />
        )}
      </div>

      {searchOpen && (
        <div className="mx-auto mt-4 w-full max-w-md px-10">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="glass-field w-full rounded-lg border border-line px-4 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-hover"
          />
        </div>
      )}

      {presets.length > 0 && !searchOpen && (
        <div className="mx-auto mt-5 flex max-w-3xl flex-wrap items-center justify-center gap-2 px-10">
          {presets.map((preset) => (
            <span key={preset.id} className="group/preset relative">
              <button
                type="button"
                onClick={() => usePreset(preset)}
                title={preset.prompt}
                className="glass-ghost rounded-full border border-line px-3 py-1 text-[12px] text-dim transition-colors hover:text-brand"
              >
                {preset.name}
              </button>
              <button
                type="button"
                aria-label={`Delete preset ${preset.name}`}
                onClick={() => deletePreset(preset.id)}
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-raised text-[10px] text-faint transition-colors hover:text-del group-hover/preset:flex"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mx-auto mt-8 w-full max-w-4xl flex-1 px-10">
        <div className="grid grid-cols-2 gap-8">
          <SessionColumn
            title="antichat"
            sessions={chatSessions}
            query={query}
            onSelect={onSelectSession}
            onDelete={removeSession}
            onDuplicate={duplicateSession}
            runningIds={runningIds}
          />
          <SessionColumn
            title="anticode"
            sessions={codeSessions}
            query={query}
            onSelect={onSelectSession}
            onDelete={removeSession}
            onDuplicate={duplicateSession}
            runningIds={runningIds}
          />
        </div>
      </div>
      <div className="flex-[0.4]" />
    </div>
  )
}
