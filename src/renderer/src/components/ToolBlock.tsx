import { useState } from 'react'
import type { JSX } from 'react'
import type { MessagePart } from '../store/session'

type ToolPart = Extract<MessagePart, { kind: 'tool' }>

/** The one-line subject shown beside the tool name, mirroring a shell prompt. */
function subject(part: ToolPart): string {
  if (part.input === null || typeof part.input !== 'object') return ''
  const record = part.input as Record<string, unknown>
  for (const key of ['command', 'path', 'cell']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Tools fold into three work types so the transcript reads as a story:
 * reading/searching/browsing is Explore, touching files is Edit, running
 * commands is Code.
 */
function label(name: string): string {
  if (name === 'run_command') return 'Code'
  if (/^(write|edit|delete|add|fill)_/.test(name)) return 'Edit'
  return 'Explore'
}

export function ToolBlock({ part }: { part: ToolPart }): JSX.Element {
  const [open, setOpen] = useState(false)
  const line = subject(part)
  const isShell = part.name === 'run_command'

  return (
    <div className="my-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full items-baseline gap-2.5 text-left"
      >
        <span
          className={`shrink-0 text-[15px] transition-colors ${
            part.status === 'error' ? 'text-del' : 'text-text group-hover:text-brand'
          }`}
        >
          {label(part.name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-dim">{line}</span>
        <span
          className={`shrink-0 text-[11px] text-faint transition-opacity ${
            part.status === 'running' || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {part.status === 'running' ? '···' : open ? '⌃' : '⌄'}
        </span>
      </button>

      {open && (
        <div className="mt-2 overflow-hidden rounded-lg border border-line bg-surface">
          <pre className="max-h-96 overflow-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-dim">
            {isShell ? `$ ${line}\n\n` : ''}
            {part.output === '' ? '(no output yet)' : part.output}
          </pre>
        </div>
      )}
    </div>
  )
}
