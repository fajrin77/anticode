import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AttachmentInfo, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'
import { useSessionStore } from '../store/session'
import type { Session } from '../store/session'
import { Composer } from './Composer'
import { ModelPicker } from './ModelPicker'
import { SessionRow } from './SessionRow'
import chatLogo from '../assets/open-chat-logo.svg'

interface NewSessionViewProps {
  /** The fresh draft being edited, when the dashboard was opened via "+". */
  session: Session | undefined
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onToggleAutoApprove: (enabled: boolean) => void
  onSelectSession: (id: string) => void
}

function Chip({
  children,
  onClick,
  active
}: {
  children: JSX.Element | string
  onClick: () => void
  active: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors ${
        active ? 'bg-hover text-text' : 'text-dim hover:bg-raised hover:text-text'
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
  extra
}: {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onToggleAutoApprove: (enabled: boolean) => void
  extra: JSX.Element
}): JSX.Element {
  const [mode, setMode] = useState<'chat' | 'code'>('code')
  const [folder, setFolder] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<AttachmentInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'none' | 'model' | 'mode'>('none')
  const [shake, setShake] = useState(false)
  const [glow, setGlow] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const activeRun = useSessionStore((state) => state.activeRun)
  const openSession = useSessionStore((state) => state.openSession)
  const addMessage = useSessionStore((state) => state.addMessage)
  const setActiveRun = useSessionStore((state) => state.setActiveRun)

  const isStreaming = activeRun !== null
  const ready =
    status?.providerReady === true && (mode === 'chat' || folder !== null)
  const canSend = draft.trim() !== '' && !isStreaming && ready

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
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  function collect(promise: Promise<AttachmentInfo[]>): void {
    setError(null)
    void promise
      .then((added) => setAttached((current) => [...current, ...added]))
      .catch((failure) => setError((failure as Error).message))
  }

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (!canSend) {
      if (status?.providerReady === true && mode === 'code' && folder === null) {
        flagMissingFolder()
      }
      return
    }

    const attachmentIds = attached.map((item) => item.id)
    const label =
      attached.length > 0 ? `${prompt}\n\n[${attached.map((a) => a.name).join(', ')}]` : prompt

    // This is the moment the session comes into existence — bound straight to
    // the mode and folder chosen here.
    const sessionId = openSession(mode, folder)
    void window.anticode.createSession({
      sessionId,
      mode,
      workspaceRoot: mode === 'code' ? folder : null
    })

    setDraft('')
    setAttached([])
    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: label }],
      pending: false
    })
    const messageId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    addMessage({ id: messageId, role: 'assistant', parts: [], pending: true })
    setActiveRun({ runId, messageId, sessionId, startedAt: Date.now() })

    await window.anticode.sendPrompt({ sessionId, runId, prompt, attachmentIds })
  }

  return (
    <div className="shrink-0 px-10">
      <div className="mx-auto max-w-3xl" ref={boxRef}>
        {error !== null && <div className="mb-2 px-1 text-[12.5px] text-del">{error}</div>}

        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((item) => (
              <span
                key={item.id}
                className="flex items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-[12px] text-dim"
              >
                <span className="max-w-48 truncate font-mono">{item.name}</span>
                <button
                  type="button"
                  onClick={() => setAttached((c) => c.filter((a) => a.id !== item.id))}
                  className="text-faint hover:text-text"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div
          className={`relative rounded-xl border bg-surface transition-colors ${
            menu !== 'none' ? 'border-dim' : 'border-line'
          } ${shake ? 'animate-shake' : ''}`}
        >
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
            <div className="absolute bottom-full left-3 mb-2 w-72 rounded-lg border border-line bg-raised p-1.5 shadow-2xl">
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
                  className={`w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-hover ${
                    status?.autoApprove === option.value ? 'text-text' : 'text-dim'
                  }`}
                >
                  <div className="text-[12.5px]">{option.name}</div>
                  <div className="text-[11px] text-faint">{option.hint}</div>
                </button>
              ))}
              <p className="px-2 py-1.5 text-[11px] text-faint">
                High risk always asks, whatever the mode.
              </p>
            </div>
          )}

          <textarea
            rows={1}
            value={draft}
            placeholder="Describe the task…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            className="max-h-48 w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] text-text outline-none placeholder:text-faint"
          />

          <div className="flex items-center gap-1 px-2.5 pb-2.5">
            <button
              type="button"
              title="Attach files"
              onClick={() => collect(window.anticode.chooseAttachments())}
              className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-raised hover:text-text"
            >
              +
            </button>

            <Chip onClick={() => setMenu(menu === 'model' ? 'none' : 'model')} active={menu === 'model'}>
              <span className="max-w-56 truncate font-mono">
                {status?.model === '' ? 'pick a model' : (status?.model ?? '…')}
              </span>
            </Chip>

            <Chip onClick={() => setMenu(menu === 'mode' ? 'none' : 'mode')} active={menu === 'mode'}>
              {status?.autoApprove === true ? 'Auto' : 'Default'}
            </Chip>

            <div className="flex-1" />

            <button
              type="button"
              onClick={() => void (isStreaming ? window.anticode.cancelRun(activeRun.runId) : send())}
              disabled={!isStreaming && !canSend}
              aria-label={isStreaming ? 'Stop' : 'Send'}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-hover text-text transition-colors hover:bg-[#3a3a3a] disabled:cursor-not-allowed disabled:text-faint"
            >
              {isStreaming ? (
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              ) : (
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center gap-2">
          {extra}
          <div className="flex rounded-lg border border-line p-0.5">
            {(['chat', 'code'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-md px-4 py-1.5 text-[13px] transition-colors ${
                  mode === value ? 'bg-hover text-text' : 'text-dim hover:text-text'
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
                  ? 'animate-glow text-dim hover:text-text'
                  : 'border-line text-dim hover:text-text'
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
  onDelete
}: {
  title: string
  sessions: Session[]
  query: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const needle = query.trim().toLowerCase()
  const visible = sessions.filter((session) => needle === '' || session.title.toLowerCase().includes(needle))

  return (
    <div className="min-w-0">
      <div className="mb-2 px-3 text-[12.5px] text-dim">{title}</div>
      <div className="max-h-60 overflow-y-auto rounded-xl border border-line-soft">
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-faint">No sessions yet</p>
        ) : (
          visible.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onSelect={onSelect}
              onDelete={onDelete}
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
  const sessions = useSessionStore((state) => state.sessions)
  const deleteSession = useSessionStore((state) => state.deleteSession)

  // Deleting wipes the session everywhere: cancel its run if one is live,
  // free the main-process side, then drop it from the store.
  function removeSession(id: string): void {
    const run = useSessionStore.getState().activeRun
    if (run !== null && run.sessionId === id) {
      void window.anticode.cancelRun(run.runId)
    }
    void window.anticode.closeSession(id)
    deleteSession(id)
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

  const searchButton = (
    <button
      type="button"
      onClick={() => {
        setSearchOpen((value) => !value)
        setQuery('')
      }}
      title="Search sessions"
      className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${
        searchOpen ? 'border-dim text-text' : 'border-line text-dim hover:text-text'
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
            className="w-full rounded-lg border border-line bg-surface px-4 py-2 text-[13px] text-text outline-none placeholder:text-faint focus:border-hover"
          />
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
          />
          <SessionColumn
            title="anticode"
            sessions={codeSessions}
            query={query}
            onSelect={onSelectSession}
            onDelete={removeSession}
          />
        </div>
      </div>
      <div className="flex-[0.4]" />
    </div>
  )
}
