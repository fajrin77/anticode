import { useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { useActiveSession } from '../store/session'
import type { Message } from '../store/session'
import { ToolBlock } from './ToolBlock'
import { RichText } from './RichText'
import wordmark from '../assets/anticode-wordmark.svg'

function MessageView({ message }: { message: Message }): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end py-4">
        <div className="max-w-[80%] rounded-xl bg-raised px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-text">
          {message.parts.map((part, index) =>
            part.kind === 'text' ? <span key={index}>{part.text}</span> : null
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="py-4 text-[15px] leading-relaxed text-text">
      {message.parts.map((part, index) =>
        part.kind === 'tool' ? (
          <ToolBlock key={part.toolUseId} part={part} />
        ) : (
          <div key={`text-${index}`} className="my-2">
            <RichText text={part.text} />
          </div>
        )
      )}
      {message.pending && (
        <div className="mt-2 flex items-center gap-2 text-[13px] text-faint">
          <span className="h-2 w-2 animate-pulse rounded-full bg-dim" />
          bekerja
        </div>
      )}
    </div>
  )
}

export function SessionView(): JSX.Element {
  const session = useActiveSession()
  const bottomRef = useRef<HTMLDivElement>(null)
  const messages = session?.messages ?? []

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-10 pt-3 pb-4">
        <h1 className="truncate text-[17px] text-text">{session?.title ?? 'Sesi baru'}</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-10">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 pb-16">
            <img src={wordmark} alt="anticode" className="w-56 opacity-90" />
            <p className="text-[13px] text-faint">
              {session?.mode === 'chat'
                ? 'Tanya apa saja. Sesi ini tidak menyentuh berkas.'
                : 'Beri instruksi untuk mulai bekerja di folder project.'}
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl pb-6">
            {messages.map((message) => (
              <MessageView key={message.id} message={message} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  )
}
