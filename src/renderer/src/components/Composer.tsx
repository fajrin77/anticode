import { useEffect, useRef, useState } from 'react'
import type { DragEvent, JSX } from 'react'
import { useActiveSession, useSessionStore } from '../store/session'
import { ModelPicker } from './ModelPicker'
import type { AttachmentInfo, ProviderId, ProviderInfo, SessionStatus } from '@shared/ipc'

interface ComposerProps {
  status: SessionStatus | null
  providers: ProviderInfo[]
  onSelectProvider: (provider: ProviderId, model: string) => void
  onToggleAutoApprove: (enabled: boolean) => void
  /** Fresh-session layout: the picker row for mode and folder sits below. */
  hero?: boolean
  /** Appended to the right end of the hero picker row (e.g. a search button). */
  heroExtra?: JSX.Element
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

export function Composer({
  status,
  providers,
  onSelectProvider,
  onToggleAutoApprove,
  hero = false,
  heroExtra
}: ComposerProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<AttachmentInfo[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'none' | 'model' | 'mode' | 'folder'>('none')
  const [shake, setShake] = useState(false)
  const [glow, setGlow] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  const session = useActiveSession()
  const activeRun = useSessionStore((state) => state.activeRun)
  const addMessage = useSessionStore((state) => state.addMessage)
  const setActiveRun = useSessionStore((state) => state.setActiveRun)
  const updateSessionConfig = useSessionStore((state) => state.updateSessionConfig)

  const isStreaming = activeRun !== null
  // A code session is only usable once it is bound to a folder; chat never needs one.
  const sessionReady =
    session !== undefined && (session.mode === 'chat' || session.projectRoot !== null)
  const blocked = status?.providerReady !== true
    ? (status?.blockedReason ?? null)
    : sessionReady
      ? null
      : hero
        ? null
        : 'This code session is not connected to a project folder'
  const canSend = draft.trim() !== '' && !isStreaming && blocked === null


  useEffect(() => {
    function onOutside(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) setMenu('none')
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [])

  async function collect(promise: Promise<AttachmentInfo[]>): Promise<void> {
    setError(null)
    try {
      const added = await promise
      setAttached((current) => [...current, ...added])
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDragging(false)
    const paths = Array.from(event.dataTransfer.files).map((file) =>
      window.anticode.pathForFile(file)
    )
    if (paths.length > 0) void collect(window.anticode.addAttachments(paths))
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

  async function send(): Promise<void> {
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
    const label =
      attached.length > 0 ? `${prompt}\n\n[${attached.map((a) => a.name).join(', ')}]` : prompt

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
    setActiveRun({ runId, messageId, sessionId: session.id, startedAt: Date.now() })

    // The first prompt finalises a fresh session's binding: the main process
    // session is (re)created with the mode and folder chosen in the hero.
    if (session.messages.length === 0) {
      void window.anticode.createSession({
        sessionId: session.id,
        mode: session.mode,
        workspaceRoot: session.mode === 'code' ? session.projectRoot : null
      })
    }

    await window.anticode.sendPrompt({ sessionId: session.id, runId, prompt, attachmentIds })
  }

  const shortModel = status?.model === '' ? 'pick a model' : (status?.model ?? '…')
  // Code sessions always name the repo they are bound to, right in the composer.
  const folder =
    session?.mode === 'code' && session.projectRoot !== null
      ? (session.projectRoot.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? session.projectRoot)
      : null

  return (
    <div
      className={hero ? 'shrink-0 px-10' : 'shrink-0 px-10 pb-6'}
      onDragOver={(event) => {
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="mx-auto max-w-3xl" ref={boxRef}>
        {blocked !== null && <div className="mb-2 px-1 text-[12.5px] text-dim">{blocked}</div>}
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
            dragging ? 'border-dim' : 'border-line'
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
                { value: true, name: 'Auto', hint: 'Run everything without asking' }
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
                Turn Auto off to be asked again.
              </p>
            </div>
          )}

          <textarea
            rows={1}
            value={draft}
            placeholder={
              dragging
                ? 'Drop files here'
                : session?.mode === 'chat'
                  ? 'Ask anything…'
                  : 'Describe the task…'
            }
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
              onClick={() => void collect(window.anticode.chooseAttachments())}
              className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-raised hover:text-text"
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

            <Chip onClick={() => setMenu(menu === 'model' ? 'none' : 'model')} active={menu === 'model'}>
              <span className="max-w-56 truncate font-mono">{shortModel}</span>
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
                      ? 'bg-[#d1fa22] font-medium text-[#1a1a1a]'
                      : 'text-dim hover:text-text'
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
                    ? 'animate-glow text-dim hover:text-text'
                    : 'border-line text-dim hover:text-text'
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
