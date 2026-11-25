import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { MessagePart } from '../store/session'
import { DiffView } from './DiffView'
import { parseUnifiedDiff } from '../diff'

type ToolPart = Extract<MessagePart, { kind: 'tool' }>

/** The one-line subject shown beside the tool name, mirroring a shell prompt. */
function subject(part: ToolPart): string {
  // An MCP or plugin tool is named after its server/plugin and itself.
  const mcp = /^(?:mcp|plugin)__(.+?)__(.+)$/.exec(part.name)
  if (mcp !== null) return `${mcp[1]} · ${mcp[2]}`
  if (part.input === null || typeof part.input !== 'object') return ''
  const record = part.input as Record<string, unknown>
  if (part.name === 'apply_patch' && typeof record.patch === 'string') {
    const paths = [...record.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((entry) => entry !== '')
    if (paths.length > 0) return paths.join(', ')
  }
  for (const key of ['command', 'path', 'cell', 'description']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Tools fold into three work types so the transcript reads as a story:
 * reading/searching/browsing is Explore, touching files is Edit, running
 * commands is Code. A sub-agent sent off with `task` is an Agent.
 */
function label(name: string): string {
  if (name === 'task') return 'Agent'
  if (name.startsWith('mcp__')) return 'MCP'
  if (name.startsWith('plugin__')) return 'Plugin'
  if (name === 'run_command') return 'Code'
  if (name === 'apply_patch' || /^(write|edit|delete|add|fill|create|format)_/.test(name)) return 'Edit'
  return 'Explore'
}

export function ToolBlock({ part }: { part: ToolPart }): JSX.Element {
  const [open, setOpen] = useState(false)
  const line = subject(part)
  const isShell = part.name === 'run_command'
  const stats = useMemo(() => (part.diff === undefined ? null : parseUnifiedDiff(part.diff)), [part.diff])

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
        {stats !== null && (
          <span className="shrink-0 text-[12px] tabular-nums">
            {stats.added > 0 && <span className="text-add">+{stats.added}</span>}
            {stats.added > 0 && stats.removed > 0 && ' '}
            {stats.removed > 0 && <span className="text-del">−{stats.removed}</span>}
          </span>
        )}
        <span
          className={`shrink-0 text-[11px] text-faint transition-opacity ${
            part.status === 'running' || open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {part.status === 'running' ? '···' : open ? '⌃' : '⌄'}
        </span>
      </button>

      {open && part.diff !== undefined && (
        <div className="mt-2">
          <DiffView patch={part.diff} path={line} />
        </div>
      )}
      {open && part.diff === undefined && (
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
