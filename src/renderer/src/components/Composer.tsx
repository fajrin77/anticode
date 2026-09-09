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
  onToggleAutoApprove
}: ComposerProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<AttachmentInfo[]>([])
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<'none' | 'model' | 'mode'>('none')
  const boxRef = useRef<HTMLDivElement>(null)

  const session = useActiveSession()
  const activeRun = useSessionStore((state) => state.activeRun)
  const addMessage = useSessionStore((state) => state.addMessage)
  const setActiveRun = useSessionStore((state) => state.setActiveRun)

  const isStreaming = activeRun !== null
  // A code session is only usable once it is bound to a folder; chat never needs one.
  const sessionReady =
    session !== undefined && (session.mode === 'chat' || session.projectRoot !== null)
  const blocked = status?.providerReady !== true
    ? (status?.blockedReason ?? null)
    : sessionReady
      ? null
      : 'Sesi Code ini belum terhubung ke folder project'
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

  async function send(): Promise<void> {
    const prompt = draft.trim()
    if (!canSend || session === undefined) return

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
    setActiveRun({ runId, messageId })

    await window.anticode.sendPrompt({ sessionId: session.id, runId, prompt, attachmentIds })
  }

  const shortModel = status?.model === '' ? 'pilih model' : (status?.model ?? '…')

  return (
    <div
      className="shrink-0 px-10 pb-6"
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
          }`}
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
                { value: false, name: 'Default', hint: 'Tanya sebelum mengubah apa pun' },
                { value: true, name: 'Auto', hint: 'Lewati tanya untuk risiko sedang' }
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
                Risiko tinggi selalu ditanya, apa pun modenya.
              </p>
            </div>
          )}

          <textarea
            rows={1}
            value={draft}
            placeholder={
              dragging
                ? 'Lepaskan berkas di sini'
                : session?.mode === 'chat'
                  ? 'Tanya apa saja…'
                  : 'Ask anything, @ untuk lampiran…'
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
              title="Lampirkan berkas"
              onClick={() => void collect(window.anticode.chooseAttachments())}
              className="flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors hover:bg-raised hover:text-text"
            >
              +
            </button>

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
              aria-label={isStreaming ? 'Hentikan' : 'Kirim'}
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
      </div>
    </div>
  )
}
