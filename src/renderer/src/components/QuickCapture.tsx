import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { SessionMode, SessionStatus } from '@shared/ipc'
import { modelLabel } from '@shared/ipc'

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function folderName(root: string): string {
  return root.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? root
}

/**
 * The panel the menu-bar icon and ⌘⌥Space open over any app: one prompt, sent
 * to a new session. Enter sends and stays out of the way; ⌘Enter sends and
 * brings anticode up on it; Tab switches antichat and anticode; Escape closes.
 */
export function QuickCapture(): JSX.Element {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<SessionMode>('chat')
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // The window is see-through so the system blur shows; the page follows.
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const refresh = (): void => {
      setError(null)
      void window.anticode.getStatus().then(setStatus)
      window.setTimeout(() => field.current?.focus(), 0)
    }
    refresh()
    return window.anticode.onQuickOpened(refresh)
  }, [])

  const folder = status?.workspaceRoot ?? null
  const canCode = folder !== null

  async function send(open: boolean): Promise<void> {
    if (text.trim() === '' || sending) return
    setSending(true)
    setError(null)
    try {
      await window.anticode.sendQuickCapture({ text, mode: mode === 'code' && canCode ? 'code' : 'chat', open })
      setText('')
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full flex-col p-2">
      <div className="composer-glass flex min-h-0 flex-1 flex-col rounded-[18px] border">
        <textarea
          ref={field}
          value={text}
          rows={2}
          autoFocus
          placeholder="Ask anticode anything…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              void window.anticode.hideQuickCapture()
            } else if (event.key === 'Tab' && canCode) {
              event.preventDefault()
              setMode(mode === 'chat' ? 'code' : 'chat')
            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send(event.metaKey || event.ctrlKey)
            }
          }}
          className="min-h-0 flex-1 resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-6 text-text outline-none placeholder:text-faint"
        />
        <div className="flex items-center gap-2 px-3 pb-2.5 text-[12px]">
          {(['chat', 'code'] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={option === 'code' && !canCode}
              onClick={() => setMode(option)}
              title={option === 'code' && !canCode ? 'Pick a project folder in anticode first' : undefined}
              className={`rounded-md border px-2 py-0.5 transition-colors enabled:hover:text-brand disabled:text-faint/60 ${
                mode === option ? 'glass-control text-text' : 'border-transparent text-dim'
              }`}
            >
              {option === 'chat' ? 'antichat' : `anticode${folder !== null ? ` · ${folderName(folder)}` : ''}`}
            </button>
          ))}
          <span className="min-w-0 flex-1 truncate text-right font-mono text-faint">{error ?? modelLabel(status)}</span>
        </div>
      </div>
      <div className={`px-3 pt-1 text-[11px] ${error !== null ? 'text-del' : 'text-faint'}`}>
        {error !== null ? error : sending ? 'Sending…' : '↵ send · ⌘↵ send and open · ⇥ antichat/anticode · esc close'}
      </div>
    </div>
  )
}
