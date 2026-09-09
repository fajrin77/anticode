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
      {message.summary !== undefined && <RunSummaryCard message={message} />}
    </div>
  )
}

/** Formats 469000 ms as "7m 49s", 42000 ms as "42s". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

interface FileStat {
  path: string
  added: number
  removed: number
}

const STAT_PATTERN = /\(\+(\d+)(?:\s*-\s*(\d+))?\)/

/** Files the run touched, with per-file line counts from tool outputs. */
function fileStats(parts: MessagePart[]): FileStat[] {
  const files = new Map<string, FileStat>()
  for (const part of parts) {
    if (part.kind !== 'tool') continue
    if (!['edit_file', 'write_file', 'delete_file'].includes(part.name)) continue
    const path =
      part.input !== null &&
      typeof part.input === 'object' &&
      typeof (part.input as Record<string, unknown>).path === 'string'
        ? ((part.input as Record<string, unknown>).path as string)
        : ''
    if (path === '') continue
    const match = STAT_PATTERN.exec(part.output)
    const stat: FileStat = {
      path,
      added: match !== null ? Number(match[1] ?? 0) : 0,
      removed: match !== null ? Number(match[2] ?? 0) : 0
    }
    const existing = files.get(path)
    if (existing === undefined) {
      files.set(path, stat)
    } else {
      existing.added += stat.added
      existing.removed += stat.removed
    }
  }
  return [...files.values()]
}

function RunSummaryCard({ message }: { message: Message }): JSX.Element {
  const [open, setOpen] = useState(false)
  const files = fileStats(message.parts)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const summary = message.summary
  if (summary === undefined) return <></>
  const { model, durationMs } = summary

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface/60 px-4 py-3">
      <div className="flex items-center gap-2 text-[12.5px] text-faint">
        <span className="h-1.5 w-1.5 rounded-full bg-add" />
        <span className="min-w-0 flex-1 truncate">
          {model === '' ? 'done' : model} · {formatDuration(durationMs)}
        </span>
      </div>
      {files.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="group mt-2 flex w-full items-center gap-2 text-left"
          >
            <span className="text-[13.5px] text-text">
              {files.length} changed {files.length === 1 ? 'file' : 'files'}
            </span>
            <span className="text-[12.5px] text-add">+{added}</span>
            <span className="text-[12.5px] text-del">−{removed}</span>
            <span
              className={`ml-auto text-[11px] text-faint transition-opacity ${
                open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              {open ? '⌃' : '⌄'}
            </span>
          </button>
          {open && (
            <div className="mt-1.5 border-t border-line-soft pt-1.5">
              {files.map((file) => (
                <div key={file.path} className="flex items-baseline gap-2 py-0.5 text-[12px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-dim">{file.path}</span>
                  {file.added > 0 && <span className="text-add">+{file.added}</span>}
                  {file.removed > 0 && <span className="text-del">−{file.removed}</span>}
                </div>
              ))}
            </div>
          )}
        </>
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
