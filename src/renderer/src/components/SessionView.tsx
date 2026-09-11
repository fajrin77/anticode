import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { isTypedPrompt, useActiveSession, useSessionStore } from '../store/session'
import type { Message, MessagePart } from '../store/session'
import type { ProviderSelection, RotationEntryStatus } from '@shared/ipc'
import { ToolBlock } from './ToolBlock'
import { RichText } from './RichText'
import { Attachments } from './Attachments'
import { Artifacts, documentsProduced } from './Artifacts'
import { DiffView } from './DiffView'
import { formatUsd } from '../money'

type ToolPart = Extract<MessagePart, { kind: 'tool' }>

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'tools'; parts: ToolPart[] }

/** Runs of tool calls fold into one group; narration between them stays loose. */
function groupBlocks(parts: MessagePart[]): Block[] {
  const blocks: Block[] = []
  for (const part of parts) {
    if (part.kind === 'attachments') continue
    if (part.kind === 'notice') {
      blocks.push({ kind: 'notice', text: part.text })
      continue
    }
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

function ToolGroup({
  parts,
  open: openFromParent,
  onToggle: toggleFromParent
}: {
  parts: ToolPart[]
  /** Given while this is the live run: the working line folds it. */
  open?: boolean
  onToggle?: () => void
}): JSX.Element {
  const [openSelf, setOpenSelf] = useState(false)
  const open = openFromParent ?? openSelf
  const setOpen = (change: (value: boolean) => boolean): void => {
    if (toggleFromParent !== undefined) toggleFromParent()
    else setOpenSelf(change)
  }
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
        <span className="min-w-0 flex-1 truncate text-[14px] text-dim transition-colors group-hover:text-brand">
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

/** Counts tool calls by work type, for the finished-run summary line. */
function breakdownOf(parts: MessagePart[]): string {
  let explore = 0
  let edit = 0
  let code = 0
  let agents = 0
  for (const part of parts) {
    if (part.kind !== 'tool') continue
    if (part.name === 'task') agents += 1
    else if (part.name === 'run_command') code += 1
    else if (/^(write|edit|delete|add|fill)_/.test(part.name)) edit += 1
    else explore += 1
  }
  const bits: string[] = []
  if (explore > 0) bits.push(`${explore} explored`)
  if (edit > 0) bits.push(`${edit} edited`)
  if (code > 0) bits.push(`${code} code`)
  if (agents > 0) bits.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`)
  return bits.length > 0 ? ` · ${bits.join(' · ')}` : ''
}

/** True while a run — this window's or one it mirrors — works in the session. */
function useSessionBusy(sessionId: string): boolean {
  return useSessionStore(
    (state) =>
      Object.values(state.activeRuns).some((run) => run.sessionId === sessionId) ||
      Object.values(state.mirrorRuns).some((run) => run.sessionId === sessionId)
  )
}

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * Takes a prompt back to be edited: it and everything after it — replies,
 * later prompts, and the file changes their runs made — come out of the
 * session, and the prompt goes back in the composer with its files. Two
 * clicks, because what goes with it cannot be brought back.
 */
function EditPrompt({ sessionId, message }: { sessionId: string; message: Message }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function takeBack(): Promise<void> {
    const store = useSessionStore.getState()
    const messages = store.sessions.find((session) => session.id === sessionId)?.messages ?? []
    const index = messages.findIndex((entry) => entry.id === message.id)
    // Counted from the end, the way the main process counts its prompts.
    const count = messages.slice(index).filter(isTypedPrompt).length
    try {
      const taken = await window.anticode.takeBackPrompt(sessionId, count)
      setConfirming(false)
      if (taken === null) return
      store.dropFrom(sessionId, message.id)
      store.updateDraft(sessionId, { text: taken.prompt })
      const paths = taken.attachments.map((item) => item.path)
      if (paths.length > 0) {
        void window.anticode
          .addAttachments(paths)
          .then((attachments) => useSessionStore.getState().updateDraft(sessionId, { attachments }))
          .catch(() => undefined)
      }
      document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  return (
    <div
      className={`flex h-6 items-center gap-3 text-[12px] transition-opacity ${
        confirming || error !== null ? 'opacity-100' : 'opacity-0 group-hover/prompt:opacity-100 focus-within:opacity-100'
      }`}
    >
      {error !== null ? (
        <button type="button" onClick={() => setError(null)} className="text-del transition-colors hover:text-brand">
          {error}
        </button>
      ) : confirming ? (
        <>
          <span className="text-faint">Later replies and their file changes go too.</span>
          <button type="button" onClick={() => void takeBack()} className="text-dim transition-colors hover:text-del">
            Take back
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="text-faint transition-colors hover:text-brand">
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          title="Edit this prompt and send it again"
          className="flex items-center gap-1 text-faint transition-colors hover:text-brand"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M10.5 2.5l3 3L6 13H3v-3z" strokeLinejoin="round" />
          </svg>
          Edit
        </button>
      )}
    </div>
  )
}

/**
 * Answers the last prompt again, drawn as this window's own run: the prompt
 * stays, the reply goes, and a fresh one streams in its place.
 */
async function retryLastPrompt(sessionId: string, choice: ProviderSelection | null): Promise<void> {
  const store = useSessionStore.getState()
  const messages = store.sessions.find((session) => session.id === sessionId)?.messages ?? []
  const prompt = messages.findLast(isTypedPrompt)
  if (prompt === undefined) return
  store.dropAfter(sessionId, prompt.id)
  const runId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  store.addMessage({ id: messageId, role: 'assistant', parts: [], pending: true })
  store.setActiveRun({ runId, messageId, sessionId, startedAt: Date.now() })
  try {
    await window.anticode.regenerate(sessionId, runId, choice)
  } catch (failure) {
    const next = useSessionStore.getState()
    next.setActiveRun(null, runId)
    // The main process decides what is left; a refused retry left it all.
    const snapshot = await window.anticode.getSessionSnapshot(sessionId)
    if (snapshot !== null) next.importSnapshot(sessionId, snapshot.messages, snapshot.summaries)
    next.addNotice(sessionId, `Retry failed: ${errorText(failure)}`)
  }
}

function MessageView({
  message,
  sessionId,
  lastAnswer
}: {
  message: Message
  sessionId: string
  /** The session's latest finished reply, which can be answered again. */
  lastAnswer: boolean
}): JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(false)
  const busy = useSessionBusy(sessionId)
  const chat = useSessionStore(
    (state) => state.sessions.find((session) => session.id === sessionId)?.mode === 'chat'
  )

  if (message.role === 'user') {
    const files = message.parts.flatMap((part) => (part.kind === 'attachments' ? part.items : []))
    const text = message.parts
      .map((part) => (part.kind === 'text' ? part.text : ''))
      .join('')

    return (
      <div className="group/prompt flex flex-col items-end gap-2 pt-4 pb-1">
        {files.length > 0 && <Attachments items={files} />}
        {text.trim() !== '' && (
          <div className="max-w-[80%] rounded-xl bg-raised px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-text">
            {text}
          </div>
        )}
        {/* Always the same height, shown or not: hovering never moves the transcript. */}
        {isTypedPrompt(message) && !busy ? <EditPrompt sessionId={sessionId} message={message} /> : <div className="h-6" />}
      </div>
    )
  }

  const blocks = groupBlocks(message.parts)
  const tail = blocks.at(-1)
  const tailRunning =
    tail !== undefined && tail.kind === 'tools' && tail.parts.some((part) => part.status === 'running')
  const done = message.summary !== undefined
  const documents = documentsProduced(message.parts, chat)
  // While the run streams, keep live tool details closed unless the user opens
  // them. Auto-opening the first streamed tool made the transcript flash between
  // the compact "working" line and an expanded/collapsed steps block.
  const [liveOpen, setLiveOpen] = useState(false)

  return (
    <div className="py-4 text-[15px] leading-relaxed text-text">
      {blocks.map((block, index) => {
        if (block.kind === 'text') {
          return (
            <div key={`text-${index}`} className="my-2">
              <RichText text={block.text} />
            </div>
          )
        }
        // The app talking about itself, in the same grey voice a tool group
        // uses — never a bubble, because nobody said it.
        if (block.kind === 'notice') {
          return (
            <div
              key={`notice-${index}`}
              className="my-3 text-[14px] text-dim transition-colors hover:text-brand"
            >
              {block.text}
            </div>
          )
        }
        // A finished run hides its tool groups behind the summary line, so the
        // closing summary is what stays visible, not a wall of steps.
        return done && !stepsOpen ? null : (
          <ToolGroup
            key={block.parts[0]?.toolUseId ?? `tools-${index}`}
            parts={block.parts}
            {...(tailRunning && block === tail ? { open: liveOpen, onToggle: () => setLiveOpen((value) => !value) } : {})}
          />
        )
      })}
      {documents.length > 0 && <Artifacts sessionId={sessionId} paths={documents} />}
      {message.pending && !tailRunning && (
        <button
          type="button"
          onClick={() => setLiveOpen(true)}
          className="mt-2 flex items-center gap-2.5 text-[14px] text-dim transition-colors hover:text-brand"
        >
          <span className="h-2.5 w-2.5 animate-breathe rounded-full bg-dim" />
          working
        </button>
      )}
      {done && (
        <RunSummaryCard
          message={message}
          open={stepsOpen}
          onToggle={() => setStepsOpen((value) => !value)}
          {...(lastAnswer && !busy ? { onRetry: (choice: ProviderSelection | null) => void retryLastPrompt(sessionId, choice) } : {})}
        />
      )}
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
  /** Every change the run made to it, oldest first. */
  diffs: string[]
}

const STAT_PATTERN = /\(\+(\d+)(?:\s*-\s*(\d+))?\)/

/** Files the run touched, with per-file line counts from tool outputs. */
function fileStats(parts: MessagePart[]): FileStat[] {
  const files = new Map<string, FileStat>()
  for (const part of parts) {
    if (part.kind !== 'tool' || part.status !== 'ok') continue
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
      removed: match !== null ? Number(match[2] ?? 0) : 0,
      diffs: part.diff !== undefined ? [part.diff] : []
    }
    const existing = files.get(path)
    if (existing === undefined) {
      files.set(path, stat)
    } else {
      existing.added += stat.added
      existing.removed += stat.removed
      existing.diffs.push(...stat.diffs)
    }
  }
  return [...files.values()]
}

/** 12,480 → "12,480"; the closing line is read, not parsed. */
function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

/** What the copy button puts on the clipboard: the reply, then what it cost. */
function summaryText(message: Message): string {
  const said = message.parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('')
    .trim()
  const summary = message.summary
  const stats =
    summary === undefined
      ? []
      : [
          summary.model,
          formatDuration(summary.durationMs),
          `${formatNumber(summary.inputTokens + summary.outputTokens)} tokens`,
          ...(summary.costUsd !== undefined && summary.costUsd > 0 ? [`${summary.costPartial === true ? '≥ ' : '~'}${formatUsd(summary.costUsd)}`] : [])
        ]
  return [said, stats.join(' · ')].filter((part) => part !== '').join('\n\n')
}

/**
 * Retry and its model menu: the same model, or any model switched on in
 * Settings → Models. Under Rotate usage the pool decides, so only "same".
 */
function RetryButton({ onRetry, onOpenChange }: { onRetry: (choice: ProviderSelection | null) => void; onOpenChange: (open: boolean) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<RotationEntryStatus[] | null>(null)
  const [rotating, setRotating] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    onOpenChange(open)
    if (!open) return
    void window.anticode.getStatus().then((status) => {
      setRotating(status.rotationEnabled)
      setModels(status.rotation.filter((entry) => entry.ready))
    })
    function onOutside(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function pick(choice: ProviderSelection | null): void {
    setOpen(false)
    onRetry(choice)
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        title="Answer this prompt again"
        onClick={() => setOpen((value) => !value)}
        className={`flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:text-brand ${open ? 'text-brand' : 'text-faint'}`}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M13 8a5 5 0 1 1-1.5-3.6" strokeLinecap="round" />
          <path d="M13 2.5V5h-2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>retry</span>
      </button>
      {open && (
        <div className="menu-glass absolute bottom-full left-1/2 z-30 mb-1 max-h-72 w-72 -translate-x-1/2 overflow-y-auto rounded-xl border p-1.5">
          <button
            type="button"
            onClick={() => pick(null)}
            className="w-full rounded px-2 py-1.5 text-left text-[12.5px] text-text transition-colors hover:bg-hover hover:text-brand"
          >
            {rotating ? 'Retry · rotate picks the model' : 'Retry with the same model'}
          </button>
          {!rotating && (models ?? []).length > 0 && (
            <div className="mt-1 border-t border-line-soft pt-1">
              <div className="px-2 py-1 text-[11px] text-faint">Retry with</div>
              {(models ?? []).map((entry) => (
                <button
                  key={`${entry.provider}:${entry.model}`}
                  type="button"
                  onClick={() => pick({ provider: entry.provider, model: entry.model })}
                  className="group flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-hover"
                >
                  <span className="truncate font-mono text-[12px] text-dim transition-colors group-hover:text-brand">{entry.model}</span>
                  <span className="shrink-0 text-[11px] text-faint transition-colors group-hover:text-brand">{entry.label}</span>
                </button>
              ))}
            </div>
          )}
          {models === null && <div className="px-2 py-1.5 text-[11px] text-faint">…</div>}
        </div>
      )}
    </div>
  )
}

function RunSummaryCard({
  message,
  open,
  onToggle,
  onRetry
}: {
  message: Message
  open: boolean
  onToggle: () => void
  /** Only on the latest reply, and only while nothing runs. */
  onRetry?: (choice: ProviderSelection | null) => void
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [shownFile, setShownFile] = useState<string | null>(null)
  const files = fileStats(message.parts)
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  const summary = message.summary
  if (summary === undefined) return <></>
  const { model, durationMs } = summary
  const steps = message.parts.filter((part) => part.kind === 'tool').length
  const tokens = summary.inputTokens + summary.outputTokens

  // A faint, centred footnote rather than a card — hidden until the cursor
  // comes near, so the conversation stays the only thing on stage. Clicking
  // unfolds both the changed files and the run's tool steps.
  return (
    <div className="group mt-2 flex flex-col items-center">
      <div
        className={`flex items-center gap-2 text-[12.5px] text-faint transition-opacity ${
          open || menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-faint transition-colors hover:text-brand"
        >
          <span>{model === '' ? 'done' : model}</span>
        </button>

        {/* Between the model and its cost, where a reader's eye already is. */}
        <button
          type="button"
          title="Copy this reply"
          onClick={() => {
            void navigator.clipboard.writeText(summaryText(message)).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-faint transition-colors hover:text-brand"
        >
          {copied ? (
            <span className="text-[11px]">copied</span>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
              <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v6a1.5 1.5 0 0 0 1.5 1.5h.5" />
            </svg>
          )}
        </button>

        {onRetry !== undefined && <RetryButton onRetry={onRetry} onOpenChange={setMenuOpen} />}

        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-faint transition-colors hover:text-brand"
        >
          <span>{formatDuration(durationMs)}</span>
          {steps > 0 && (
            <>
              <span>·</span>
              <span>
                {steps} {steps === 1 ? 'step' : 'steps'}
              </span>
              <span className="hidden sm:inline">{breakdownOf(message.parts)}</span>
            </>
          )}
          {files.length > 0 && (
            <>
              <span>·</span>
              <span>
                {files.length} {files.length === 1 ? 'file' : 'files'}
              </span>
              {added > 0 && <span className="text-add">+{added}</span>}
              {removed > 0 && <span className="text-del">−{removed}</span>}
            </>
          )}
          {tokens > 0 && (
            <>
              <span>·</span>
              <span>{formatNumber(tokens)} tokens</span>
            </>
          )}
          {summary.costUsd !== undefined && summary.costUsd > 0 && (
            <>
              <span>·</span>
              <span title={summary.costPartial === true ? 'Part of this run used a model with no price' : 'Estimated from Settings → Pricing'}>
                {summary.costPartial === true ? '≥ ' : '~'}
                {formatUsd(summary.costUsd)}
              </span>
            </>
          )}
        </button>
      </div>
      {open && files.length > 0 && (
        <div className="mt-1 flex w-full flex-col items-center">
          {files.map((file) => (
            <div key={file.path} className="flex w-full flex-col items-center">
              <button
                type="button"
                disabled={file.diffs.length === 0}
                onClick={() => setShownFile(shownFile === file.path ? null : file.path)}
                title={file.diffs.length > 0 ? 'Show what changed' : undefined}
                className="group/file flex items-baseline gap-2 py-0.5 text-[12px] enabled:cursor-pointer"
              >
                <span
                  className={`max-w-96 truncate font-mono transition-colors ${
                    file.diffs.length > 0 ? 'group-hover/file:text-brand' : ''
                  } ${shownFile === file.path ? 'text-text' : 'text-faint'}`}
                >
                  {file.path}
                </span>
                {file.added > 0 && <span className="text-add">+{file.added}</span>}
                {file.removed > 0 && <span className="text-del">−{file.removed}</span>}
              </button>
              {shownFile === file.path && (
                <div className="my-1.5 flex w-full flex-col gap-2 text-left">
                  {file.diffs.map((diff, index) => (
                    <DiffView key={index} patch={diff} path={file.path} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Selecting part of a reply offers to answer that passage: the button follows
 * the selection, and clicking it carries the text to the composer.
 */
function ReplyToSelection({ sessionId }: { sessionId: string }): JSX.Element {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null)
  const quoteInDraft = useSessionStore((state) => state.quoteInDraft)

  useEffect(() => {
    function onSelect(): void {
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''
      if (selection === null || selection.rangeCount === 0 || text === '') {
        setAt(null)
        return
      }
      // Only the conversation is quotable; the composer and chrome are not.
      const anchor = selection.anchorNode
      const host = anchor instanceof Element ? anchor : anchor?.parentElement
      if (host?.closest('[data-transcript]') == null) {
        setAt(null)
        return
      }
      const box = selection.getRangeAt(0).getBoundingClientRect()
      setAt({ x: box.left + box.width / 2, y: box.top, text })
    }
    document.addEventListener('selectionchange', onSelect)
    return () => document.removeEventListener('selectionchange', onSelect)
  }, [])

  if (at === null) return <></>
  return (
    <button
      type="button"
      // Kept off mousedown so the click lands before the selection collapses.
      onMouseDown={(event) => {
        event.preventDefault()
        quoteInDraft(sessionId, at.text)
        window.getSelection()?.removeAllRanges()
        setAt(null)
        document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
      }}
      data-reply-button
      style={{ left: at.x, top: at.y - 10 }}
      className="fixed z-40 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-raised px-3 py-1.5 text-[12.5px] text-text shadow-2xl transition-colors hover:text-brand"
    >
      Balas
    </button>
  )
}

/** How close to the end still counts as reading the end, in pixels. */
const FOLLOW_SLACK = 80

export function SessionView(): JSX.Element {
  const session = useActiveSession()
  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = session?.messages ?? []
  // The latest finished reply with no prompt after it is the one Retry answers.
  const lastPrompt = messages.findLastIndex(isTypedPrompt)
  const lastAnswerId = messages.findLast(
    (message, index) => index > lastPrompt && message.role === 'assistant' && message.summary !== undefined
  )?.id
  // The transcript follows new output only while the reader is at its end.
  // Scrolling up to read stops it; scrolling back down, sending a prompt, or
  // opening another session starts it again.
  const following = useRef(true)
  const seen = useRef<{ sessionId: string | undefined; prompts: number }>({ sessionId: undefined, prompts: 0 })

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box === null) return
    const prompts = messages.filter((message) => message.role === 'user').length
    if (seen.current.sessionId !== session?.id || prompts > seen.current.prompts) following.current = true
    seen.current = { sessionId: session?.id, prompts }
    if (following.current) box.scrollTop = box.scrollHeight
  }, [messages, session?.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReplyToSelection sessionId={session?.id ?? ''} />
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const box = event.currentTarget
          following.current = box.scrollHeight - box.scrollTop - box.clientHeight < FOLLOW_SLACK
        }}
        className="under-header min-h-0 flex-1 overflow-y-auto px-10 [scrollbar-gutter:stable_both-edges]"
      >
        <div data-transcript className="session-transcript mx-auto max-w-3xl">
          {messages.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              sessionId={session?.id ?? ''}
              lastAnswer={message.id === lastAnswerId}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
