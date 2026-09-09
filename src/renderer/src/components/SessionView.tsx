import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useActiveSession } from '../store/session'
import type { Message, MessagePart } from '../store/session'
import { ToolBlock } from './ToolBlock'
import { RichText } from './RichText'

type ToolPart = Extract<MessagePart, { kind: 'tool' }>

type Block = { kind: 'text'; text: string } | { kind: 'tools'; parts: ToolPart[] }

/** Runs of tool calls fold into one group; narration between them stays loose. */
function groupBlocks(parts: MessagePart[]): Block[] {
  const blocks: Block[] = []
  for (const part of parts) {
    if (part.kind !== 'tool') {
      blocks.push({ kind: 'text', text: part.text })
      continue
    }
    const last = blocks.at(-1)
    if (last?.kind === 'tools') last.parts.push(part)
    else blocks.push({ kind: 'tools', parts: [part] })
  }
  return blocks
}

function ToolGroup({ parts }: { parts: ToolPart[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = parts.some((part) => part.status === 'running')
  const failed = parts.filter((part) => part.status === 'error').length

  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-center gap-2.5 text-left"
      >
        {running ? (
          <span className="h-2 w-2 shrink-0 animate-breathe rounded-full bg-dim" />
        ) : (
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${failed > 0 ? 'bg-del' : 'bg-faint'}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px] text-dim">
          {running
            ? `working · ${parts.length} steps`
            : failed > 0
              ? `ran ${parts.length} steps · ${failed} failed`
              : `ran ${parts.length} steps`}
        </span>
        <span
          className={`shrink-0 text-[11px] text-faint transition-opacity ${
            open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {open ? '⌃' : '⌄'}
        </span>
      </button>

      {open && (
        <div className="mt-1 border-l border-line pl-4">
          {parts.map((part) => (
            <ToolBlock key={part.toolUseId} part={part} />
          ))}
        </div>
      )}
    </div>
  )
}

function MessageView({ message }: { message: Message }): JSX.Element {
  const blocks = groupBlocks(message.parts)
  const tail = blocks.at(-1)
  const tailRunning =
    tail !== undefined && tail.kind === 'tools' && tail.parts.some((part) => part.status === 'running')

  return (
    <div className="py-4 text-[15px] leading-relaxed text-text">
      {blocks.map((block, index) =>
        block.kind === 'tools' ? (
          <ToolGroup
            key={block.parts[0]?.toolUseId ?? `tools-${index}`}
            parts={block.parts}
          />
        ) : (
          <div key={`text-${index}`} className="my-2">
            <RichText text={block.text} />
          </div>
        )
      )}
      {message.pending && !tailRunning && (
        <div className="mt-2 flex items-center gap-2.5 text-[14px] text-dim">
          <span className="h-2.5 w-2.5 animate-breathe rounded-full bg-dim" />
          working
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
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-4">
        <div className="mx-auto max-w-3xl pb-6">
          {messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}
