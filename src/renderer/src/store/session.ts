import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  AttachmentInfo,
  AttachmentRef,
  QueuedPrompt,
  RunSummary,
  SessionMode,
  SessionSpec,
  SnapshotMessage
} from '@shared/ipc'
import { CONTINUE_PROMPT, SESSION_COLOURS } from '@shared/ipc'
import { FOLLOW_UP_LABEL, RESUME_LABEL } from '../labels'

export type Role = 'user' | 'assistant'
export type ToolStatus = 'running' | 'ok' | 'error'

export type MessagePart =
  | { kind: 'text'; text: string }
  /** Files sent with a prompt, drawn as pictures and cards above its text. */
  | { kind: 'attachments'; items: AttachmentRef[] }
  /**
   * A line the app writes about itself — pausing, resuming — rather than
   * anything the model or the user said. Drawn like a tool-group line: on the
   * left, grey, no bubble.
   */
  | { kind: 'notice'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      input: unknown
      status: ToolStatus
      output: string
      /** The file change it made, as a unified diff, for the diff viewer. */
      diff?: string
    }

export type { RunSummary } from '@shared/ipc'

const sessionStoreMemoryStorage: Storage = {
  get length() { return 0 },
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {}
}

export interface Message {
  id: string
  role: Role
  parts: MessagePart[]
  pending: boolean
  /** Set when the run settles; feeds the closing summary card. */
  summary?: RunSummary
  /**
   * A user message that was sent while a run was working. It rides with the
   * prompt before it, so it is not a prompt of its own to edit or retry.
   */
  followUp?: boolean
}

/**
 * A prompt somebody typed — the main process counts the same ones, from the
 * end, when a prompt is taken back to be edited.
 */
export function isTypedPrompt(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.followUp !== true &&
    message.parts.some((part) => part.kind === 'text' && part.text !== CONTINUE_PROMPT)
  )
}

export interface Project {
  root: string
  name: string
}

export interface Session {
  id: string
  title: string
  mode: SessionMode
  projectRoot: string | null
  createdAt: number
  messages: Message[]
  inputTokens: number
  outputTokens: number
  /** Provider and model of the most recent turn, for the usage panel. */
  provider: string | null
  model: string | null
  /** Input tokens of the latest request — the closest measure of context size. */
  lastInputTokens: number
  /** Estimated dollars so far; requests on a model with no price add nothing. */
  costUsd?: number
  /** Some request here had no price, so costUsd is short of the truth. */
  costPartial?: boolean
  /**
   * Closing a tab only hides it: the session (with its whole transcript)
   * stays in the dashboard until the user reopens or a new app run replaces it.
   */
  closed: boolean
  /** Index into SESSION_COLOURS; assigned round-robin at creation. */
  colour: number
  /** Added to this session's system prompt; kept by the main process. */
  instructions?: string
}

export interface UsageEntry {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  /** Estimated dollars, from the requests that had a price. */
  costUsd?: number
}

export interface ActiveRun {
  runId: string
  messageId: string
  /** The session that owns this run; events must land there, not in the open tab. */
  sessionId: string
  startedAt: number
  /** Tokens seen so far, so the closing line can be drawn the moment it ends. */
  inputTokens?: number
  outputTokens?: number
}

interface SessionState {
  /** `quote` is a passage from the transcript the next prompt answers. */
  drafts: Record<string, { text: string; attachments: AttachmentInfo[]; quote?: string }>
  updateDraft: (
    id: string,
    patch: Partial<{ text: string; attachments: AttachmentInfo[]; quote?: string }>
  ) => void
  projects: Project[]
  sessions: Session[]
  /** Running totals per provider+model, kept across sessions for the dashboard. */
  usage: UsageEntry[]
  seenUsageEvents: string[]
  activeSessionId: string | null
  activeRuns: Record<string, ActiveRun>
  /** Phone-initiated runs mirrored live here: runId → placeholder message. */
  mirrorRuns: Record<
    string,
    {
      sessionId: string
      messageId: string
      startedAt: number
      inputTokens?: number
      outputTokens?: number
    }
  >
  /**
   * Sessions paused on either screen; their runs were stopped, resume
   * re-prompts. A mirror of the main process, which owns the pause.
   */
  pausedSessions: Record<string, true>
  /** Next badge-colour index; advances on every session creation. */
  nextColour: number
  /** Prompts waiting for each session's run to finish; a mirror of the main process. */
  queues: Record<string, QueuedPrompt[]>
  /**
   * What Enter does with a prompt typed while a run works: join that run
   * (steer) or wait for it to finish and go out as the next run (queue).
   * Cmd/Ctrl+Enter does the other. Remembered across launches.
   */
  followUpMode: 'steer' | 'queue'
  setQueue: (sessionId: string, items: QueuedPrompt[]) => void
  setFollowUpMode: (mode: 'steer' | 'queue') => void
  /** How diffs are drawn: one column, or old and new side by side. Remembered. */
  diffLayout: 'unified' | 'split'
  setDiffLayout: (layout: 'unified' | 'split') => void

  /** Puts a passage from the transcript above the composer, to be replied to. */
  quoteInDraft: (id: string, quote: string) => void
  addProject: (root: string) => void
  openSession: (mode: SessionMode, projectRoot: string | null) => string
  selectSession: (id: string) => void
  /** Reopens a closed session's tab and makes it active. */
  reopenSession: (id: string) => void
  /** Clones a session into a fresh editable copy; the original stays untouched. */
  duplicateSession: (id: string) => string | null
  /** Branches a new session from the transcript up to and including one message. */
  forkSession: (id: string, uptoMessageId: string) => string | null
  /**
   * Brings an archived session's tab back because something happened in it —
   * a run from the phone, or from another window. The active tab is left
   * alone on purpose: a background session must not steal the view.
   */
  surfaceSession: (id: string) => void
  /** Removes a session everywhere: tab, dashboard, and history. */
  deleteSession: (id: string) => void
  /** Registers a session created elsewhere (the remote phone app). */
  addExternalSession: (spec: SessionSpec) => void
  /** The name the main process gave a session; viewers never make one up. */
  setSessionTitle: (sessionId: string, title: string) => void
  /** Fills a registered external session with its main-process transcript. */
  importSnapshot: (
    sessionId: string,
    messages: SnapshotMessage[],
    summaries?: RunSummary[]
  ) => void
  /** Adds a run's token usage to whichever live entry owns it. */
  addRunTokens: (runId: string, inputTokens: number, outputTokens: number) => void
  /** Puts the closing summary on the newest assistant message (post-import). */
  stampLastSummary: (sessionId: string, summary: RunSummary) => void
  /** Opens a live mirror placeholder for a phone-initiated run; returns its message id. */
  mirrorStart: (runId: string, sessionId: string) => string
  /** Closes a mirror placeholder once the mirrored run settles. */
  mirrorSettle: (runId: string, summary?: RunSummary) => void
  /** Mirrors a pause the main process announced (its run was stopped mid-task). */
  pauseSession: (sessionId: string) => void
  /** Mirrors a pause ending; the agent continues from its history. */
  resumeSession: (sessionId: string) => void
  /** Sets mode and project folder on a fresh session before its first prompt. */
  updateSessionConfig: (
    id: string,
    patch: { mode?: SessionMode; projectRoot?: string | null }
  ) => void
  closeSession: (id: string) => void

  addMessage: (message: Message) => void
  /**
   * An instruction joined a run that was already working. It is written under
   * the reply in progress, with the app's reaction to it; the reply itself
   * keeps streaming above until the run takes the instruction in.
   */
  steerRun: (runId: string, sessionId: string, text: string, attachments?: AttachmentRef[]) => void
  /** The run read the instructions: the reply so far closes, a fresh one opens below them. */
  takeSteer: (runId: string, sessionId: string) => void
  /** Drops messages the composer drew before the main process decided otherwise. */
  removeMessages: (sessionId: string, ids: string[]) => void
  /** Adds a remotely-sent user prompt unless it is already the last one. */
  addUserPrompt: (sessionId: string, text: string, attachments?: AttachmentRef[]) => void
  /** Notes a pause or a resume in a session's transcript, never twice running. */
  addNotice: (sessionId: string, text: string) => void
  /** Drops the transcript back to before the last typed prompt. */
  dropLastTurn: (sessionId: string) => void
  /** Drops a message and everything after it — a prompt taken back to edit. */
  dropFrom: (sessionId: string, messageId: string) => void
  /** Keeps a message and drops everything after it — the reply being retried. */
  dropAfter: (sessionId: string, messageId: string) => void
  appendText: (sessionId: string, messageId: string, text: string) => void
  startTool: (
    sessionId: string,
    messageId: string,
    toolUseId: string,
    name: string,
    input: unknown
  ) => void
  endTool: (
    sessionId: string,
    messageId: string,
    toolUseId: string,
    ok: boolean,
    output: string,
    diff?: string
  ) => void
  addUsage: (
    sessionId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    eventKey?: string,
    /** A sub-agent's request: it costs, but it is not this session's context. */
    subagent?: boolean,
    /** Estimated dollars from the main process; null when the model has no price. */
    costUsd?: number | null
  ) => void
  /** A running tool reported a step — a sub-agent reading a file. */
  progressTool: (sessionId: string, toolUseId: string, text: string) => void
  /** The app noted something about a run in progress — its context was compacted. */
  noticeInRun: (sessionId: string, messageId: string, text: string) => void
  /** The replay estimate after a compaction, until the next request measures it. */
  setContextTokens: (sessionId: string, tokens: number) => void
  settleMessage: (messageId: string, summary?: RunSummary) => void
  setActiveRun: (run: ActiveRun | null, runId?: string) => void
}

/** The diff a tool result carries, spread-ready, or nothing. */
function diffOf(result: { diff?: string } | undefined): { diff?: string } {
  return result?.diff !== undefined ? { diff: result.diff } : {}
}

function baseName(root: string): string {
  const parts = root.split(/[\\/]/).filter((part) => part !== '')
  return parts.at(-1) ?? root
}

function newSession(mode: SessionMode, projectRoot: string | null, colour: number): Session {
  return {
    id: crypto.randomUUID(),
    title: 'New session',
    mode,
    projectRoot,
    createdAt: Date.now(),
    messages: [],
    inputTokens: 0,
    outputTokens: 0,
    provider: null,
    model: null,
    lastInputTokens: 0,
    closed: false,
    colour
  }
}

function mapActive(state: SessionState, change: (session: Session) => Session): Session[] {
  return mapSession(state, state.activeSessionId, change)
}

function mapSession(
  state: SessionState,
  sessionId: string | null,
  change: (session: Session) => Session
): Session[] {
  return state.sessions.map((session) => (session.id === sessionId ? change(session) : session))
}

function mapMessage(
  session: Session,
  messageId: string,
  change: (message: Message) => Message
): Session {
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId ? change(message) : message
    )
  }
}

export const useSessionStore = create<SessionState>()(persist((set, get) => ({
  drafts: {},
  updateDraft: (id, patch) => set((state) => ({ drafts: { ...state.drafts, [id]: { text: '', attachments: [], ...state.drafts[id], ...patch } } })),
  quoteInDraft: (id, quote) =>
    set((state) => ({
      drafts: { ...state.drafts, [id]: { text: '', attachments: [], ...state.drafts[id], quote } }
    })),
  projects: [],
  sessions: [],
  usage: [],
  seenUsageEvents: [],
  activeSessionId: null,
  activeRuns: {},
  mirrorRuns: {},
  pausedSessions: {},
  nextColour: 0,
  queues: {},
  followUpMode: 'steer',
  setQueue: (sessionId, items) =>
    set((state) => {
      const queues = { ...state.queues }
      if (items.length === 0) delete queues[sessionId]
      else queues[sessionId] = items
      return { queues }
    }),
  setFollowUpMode: (followUpMode) => set({ followUpMode }),
  diffLayout: 'unified',
  setDiffLayout: (diffLayout) => set({ diffLayout }),

  addProject: (root) =>
    set((state) =>
      state.projects.some((project) => project.root === root)
        ? state
        : { projects: [...state.projects, { root, name: baseName(root) }] }
    ),

  openSession: (mode, projectRoot) => {
    let id = ''
    set((state) => {
      const session = newSession(mode, projectRoot, state.nextColour)
      if (mode === 'code' && projectRoot !== null) session.title = baseName(projectRoot)
      id = session.id
      return {
        sessions: [...state.sessions, session],
        activeSessionId: session.id,
        nextColour: (state.nextColour + 1) % SESSION_COLOURS.length
      }
    })
    return id
  },

  selectSession: (id) => set({ activeSessionId: id }),

  reopenSession: (id) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, closed: false } : session
      ),
      activeSessionId: id
    })),

  /** Clones a session's transcript and config into a fresh tab; runs stay behind. */
  duplicateSession: (id) => {
    let newId = ''
    set((state) => {
      const source = state.sessions.find((session) => session.id === id)
      if (source === undefined || source.messages.length === 0) return state
      const clone: Session = {
        ...source,
        id: crypto.randomUUID(),
        title: `${source.title} (copy)`,
        createdAt: Date.now(),
        messages: source.messages.map((message) => ({
          ...message,
          parts: message.parts.map((part) => ({ ...part }))
        })),
        inputTokens: 0,
        outputTokens: 0,
        lastInputTokens: 0,
        closed: false
      }
      newId = clone.id
      return {
        sessions: [...state.sessions, clone],
        activeSessionId: clone.id,
        nextColour: (state.nextColour + 1) % SESSION_COLOURS.length
      }
    })
    return newId
  },

  /** Replays a transcript's prefix into a fresh session — a branch from the past. */
  forkSession: (id, uptoMessageId) => {
    let newId = ''
    set((state) => {
      const source = state.sessions.find((session) => session.id === id)
      const index = source?.messages.findIndex((message) => message.id === uptoMessageId) ?? -1
      if (source === undefined || index < 0) return state
      const kept = source.messages.slice(0, index + 1)
      const clone: Session = {
        ...source,
        id: crypto.randomUUID(),
        title: `${source.title} (fork)`,
        createdAt: Date.now(),
        messages: kept.map((message) => ({
          ...message,
          parts: message.parts.map((part) => ({ ...part }))
        })),
        inputTokens: 0,
        outputTokens: 0,
        lastInputTokens: 0,
        closed: false
      }
      newId = clone.id
      return {
        sessions: [...state.sessions, clone],
        activeSessionId: clone.id,
        nextColour: (state.nextColour + 1) % SESSION_COLOURS.length
      }
    })
    return newId
  },

  surfaceSession: (id) =>
    set((state) =>
      state.sessions.some((session) => session.id === id && session.closed)
        ? {
            sessions: state.sessions.map((session) =>
              session.id === id ? { ...session, closed: false } : session
            )
          }
        : state
    ),

  // A fresh session starts as an unnamed chat; picking anticode binds the
  // folder and renames the tab to it; a chat is named by the main process
  // once its first prompt arrives.
  updateSessionConfig: (id, patch) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== id) return session
        const next = { ...session, ...patch }
        if (next.mode === 'code' && next.projectRoot !== null) {
          next.title = baseName(next.projectRoot ?? '')
        }
        return next
      })
    })),

  // A remote-created session lands here the moment the main process announces
  // it, so the desktop tab bar and dashboard stay complete.
  addExternalSession: (spec) =>
    set((state) => {
      // The main process owns colours and names; a session this window already
      // knows takes the ones it settled on, so both viewers show it the same.
      // A draft whose folder was picked here but not yet sent keeps the name
      // of that folder until the main process is told about it.
      if (state.sessions.some((session) => session.id === spec.sessionId)) {
        return {
          sessions: state.sessions.map((session) => {
            if (session.id !== spec.sessionId) return session
            const bound =
              session.mode === spec.mode && (spec.mode === 'chat' || session.projectRoot === spec.workspaceRoot)
            const colour = spec.colour ?? session.colour
            const title = bound && spec.title !== undefined ? spec.title : session.title
            const instructions = spec.instructions
            if (colour === session.colour && title === session.title && instructions === session.instructions) return session
            const { instructions: _dropped, ...rest } = session
            return { ...rest, colour, title, ...(instructions !== undefined ? { instructions } : {}) }
          })
        }
      }
      const session: Session = {
        id: spec.sessionId,
        title:
          spec.title ??
          (spec.mode === 'code' && spec.workspaceRoot !== null ? baseName(spec.workspaceRoot) : 'New session'),
        mode: spec.mode,
        projectRoot: spec.workspaceRoot,
        createdAt: Date.now(),
        messages: [],
        inputTokens: 0,
        outputTokens: 0,
        provider: null,
        model: null,
        lastInputTokens: 0,
        closed: false,
        colour: spec.colour ?? state.nextColour,
        ...(spec.instructions !== undefined ? { instructions: spec.instructions } : {})
      }
      return {
        sessions: [...state.sessions, session],
        nextColour: ((spec.colour ?? state.nextColour) + 1) % SESSION_COLOURS.length
      }
    }),

  setSessionTitle: (sessionId, title) =>
    set((state) =>
      state.sessions.some((session) => session.id === sessionId && session.title !== title)
        ? { sessions: mapSession(state, sessionId, (session) => ({ ...session, title })) }
        : state
    ),

  // Converts the main-process transcript into renderer message parts.
  // A run is either the desktop's own or one mirrored from the phone; the
  // closing line needs its tally either way.
  addRunTokens: (runId, inputTokens, outputTokens) =>
    set((state) => {
      const add = <T extends { inputTokens?: number; outputTokens?: number }>(entry: T): T => ({
        ...entry,
        inputTokens: (entry.inputTokens ?? 0) + inputTokens,
        outputTokens: (entry.outputTokens ?? 0) + outputTokens
      })
      const active = state.activeRuns[runId]
      if (active !== undefined) {
        return { activeRuns: { ...state.activeRuns, [runId]: add(active) } }
      }
      const mirrored = state.mirrorRuns[runId]
      if (mirrored !== undefined) {
        return { mirrorRuns: { ...state.mirrorRuns, [runId]: add(mirrored) } }
      }
      return state
    }),

  importSnapshot: (sessionId, messages, summaries = []) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const converted: Message[] = []
        const results = new Map(messages.flatMap((message) => message.blocks.filter((block) => block.type === 'tool_result').map((block) => [block.toolUseId, block] as const)))
        // An assistant turn followed by an instruction the run took in did not
        // end its run, so it carries no closing line; see the summaries below.
        const continued = new Set<Message>()
        for (const message of messages) {
          // A resume is the app picking a paused run back up: it reads as the
          // same grey marker the live resume wrote, not as a prompt.
          if (
            message.role === 'user' &&
            message.blocks.length === 1 &&
            message.blocks[0]?.type === 'text' &&
            message.blocks[0].text === CONTINUE_PROMPT
          ) {
            converted.push({ id: crypto.randomUUID(), role: 'assistant', parts: [{ kind: 'notice', text: RESUME_LABEL }], pending: false })
            continue
          }
          const parts: MessagePart[] = []
          let followUp: 'during' | 'after' | undefined
          const texts = message.blocks.filter((block) => block.type === 'text')
          const onlyFollowUps = texts.length > 0 && texts.every((block) => block.type === 'text' && block.followUp !== undefined)
          for (const block of message.blocks) {
            if (block.type === 'text') {
              if (block.followUp !== undefined) followUp = block.followUp
              parts.push({ kind: 'text', text: block.text })
            } else if (block.type === 'attachment') {
              // Consecutive attachments belong to one send, so they share a strip.
              const last = parts.at(-1)
              if (last?.kind === 'attachments') last.items.push(block.attachment)
              else parts.push({ kind: 'attachments', items: [block.attachment] })
            } else if (block.type === 'tool_use') {
              parts.push({
                kind: 'tool',
                toolUseId: block.id,
                name: block.name,
                input: block.input,
                status: results.get(block.id)?.isError ? 'error' : results.has(block.id) ? 'ok' : 'error',
                output: results.get(block.id)?.content ?? 'Interrupted before a result was recorded.',
                ...diffOf(results.get(block.id))
              })
            }
          }
          if (parts.length === 0) continue
          // One run spans several provider messages, split by the tool-result
          // messages between them. A live run is one message here, so a
          // restored one has to fold the same way or it reads differently.
          const previous = converted.at(-1)
          if (message.role === 'assistant' && previous?.role === 'assistant' && !previous.parts.some((part) => part.kind === 'notice')) {
            previous.parts.push(...parts)
            continue
          }
          if (followUp === 'during' && previous?.role === 'assistant') continued.add(previous)
          converted.push({
            id: crypto.randomUUID(),
            role: message.role,
            parts,
            pending: false,
            ...(message.role === 'user' && onlyFollowUps ? { followUp: true } : {})
          })
          // The reaction a live follow-up got is part of the story after a
          // reload too.
          if (followUp !== undefined) {
            converted.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              parts: [{ kind: 'notice', text: FOLLOW_UP_LABEL }],
              pending: false
            })
          }
        }
        const turns = converted.filter(
          (message) =>
            message.role === 'assistant' &&
            !continued.has(message) &&
            !message.parts.every((part) => part.kind === 'notice')
        )
        const offset = turns.length - summaries.length
        turns.forEach((message, index) => {
          const summary = summaries[index - offset]
          if (summary !== undefined) message.summary = summary
        })
        return { ...session, messages: converted }
      })
    })),

  stampLastSummary: (sessionId, summary) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const message = session.messages[i]
          if (message?.role === 'assistant') {
            if (message.summary !== undefined) return session
            const next = session.messages.slice()
            next[i] = { ...message, summary }
            return { ...session, messages: next }
          }
        }
        return session
      })
    })),

  // A run started on the phone gets a placeholder assistant message here, so
  // the desktop watches it stream in like any local run.
  mirrorStart: (runId, sessionId) => {
    const existing = get().mirrorRuns[runId]
    if (existing !== undefined) return existing.messageId
    const messageId = crypto.randomUUID()
    set((state) => ({
      mirrorRuns: {
        ...state.mirrorRuns,
        [runId]: { sessionId, messageId, startedAt: Date.now() }
      },
      sessions: mapSession(state, sessionId, (session) =>
        session.messages.some((message) => message.id === messageId)
          ? session
          : {
              ...session,
              messages: [
                ...session.messages,
                { id: messageId, role: 'assistant' as const, parts: [], pending: true }
              ]
            }
      )
    }))
    return messageId
  },

  mirrorSettle: (runId, summary) =>
    set((state) => {
      const entry = state.mirrorRuns[runId]
      if (entry === undefined) return state
      const mirrorRuns = { ...state.mirrorRuns }
      delete mirrorRuns[runId]
      return {
        mirrorRuns,
        sessions: mapSession(state, entry.sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) =>
            message.id === entry.messageId
              ? {
                  ...message,
                  pending: false,
                  ...(summary !== undefined ? { summary } : {})
                }
              : message
          )
        }))
      }
    }),

  // Deleting wipes the session from the store; the caller also cancels any
  // active run and frees the main-process side.
  deleteSession: (id) =>
    set((state) => {
      const remaining = state.sessions.filter((session) => session.id !== id)
      const activeSessionId =
        state.activeSessionId === id
          ? (remaining.filter((session) => !session.closed).at(-1)?.id ?? null)
          : state.activeSessionId
      return { sessions: remaining, activeSessionId,
        activeRuns: Object.fromEntries(Object.entries(state.activeRuns).filter(([, run]) => run.sessionId !== id)),
        mirrorRuns: Object.fromEntries(Object.entries(state.mirrorRuns).filter(([, run]) => run.sessionId !== id))
      }
    }),

  // Closing a tab archives the session instead of deleting it, and lands on
  // another open tab — or on none, which sends the view back to the dashboard.
  closeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === id ? { ...session, closed: true } : session
      )
      const activeSessionId =
        state.activeSessionId === id
          ? (sessions.filter((session) => !session.closed).at(-1)?.id ?? null)
          : state.activeSessionId
      return { sessions, activeSessionId }
    }),

  addMessage: (message) =>
    set((state) => ({
      // The name is not decided here: the main process names an antichat
      // from this prompt once it has it, and tells every viewer.
      sessions: mapActive(state, (session) => ({
        ...session,
        messages: [...session.messages, message]
      }))
    })),

  appendText: (sessionId, messageId, text) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) =>
        mapMessage(session, messageId, (message) => {
          const last = message.parts.at(-1)
          if (last?.kind === 'text') {
            return {
              ...message,
              parts: [...message.parts.slice(0, -1), { kind: 'text', text: last.text + text }]
            }
          }
          return { ...message, parts: [...message.parts, { kind: 'text', text }] }
        })
      )
    })),

  startTool: (sessionId, messageId, toolUseId, name, input) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) =>
        mapMessage(session, messageId, (message) => ({
          ...message,
          parts: [
            ...message.parts,
            { kind: 'tool', toolUseId, name, input, status: 'running', output: '' }
          ]
        }))
      )
    })),

  // Found by its id wherever it sits: a follow-up moves the run on to a fresh
  // reply while tools the earlier one started are still finishing.
  endTool: (sessionId, _messageId, toolUseId, ok, output, diff) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.parts.some((part) => part.kind === 'tool' && part.toolUseId === toolUseId)
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  part.kind === 'tool' && part.toolUseId === toolUseId
                    ? { ...part, status: ok ? 'ok' : 'error', output, ...(diff !== undefined ? { diff } : {}) }
                    : part
                )
              }
            : message
        )
      }))
    })),

  steerRun: (_runId, sessionId, text, attachments) =>
    set((state) => {
      const parts: MessagePart[] =
        attachments !== undefined && attachments.length > 0
          ? [{ kind: 'attachments', items: attachments }, { kind: 'text', text }]
          : [{ kind: 'text', text }]
      return {
        sessions: mapSession(state, sessionId, (session) => ({
          ...session,
          messages: [
            ...session.messages,
            { id: crypto.randomUUID(), role: 'user' as const, parts, pending: false, followUp: true },
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              parts: [{ kind: 'notice' as const, text: FOLLOW_UP_LABEL }],
              pending: false
            }
          ]
        }))
      }
    }),

  takeSteer: (runId, sessionId) =>
    set((state) => {
      const own = state.activeRuns[runId]
      const mirror = state.mirrorRuns[runId]
      const current = own?.messageId ?? mirror?.messageId
      const next = crypto.randomUUID()
      return {
        sessions: mapSession(state, sessionId, (session) => ({
          ...session,
          messages: [
            // An empty placeholder — nothing streamed yet — has nothing to keep.
            ...session.messages.flatMap((message) =>
              message.id !== current
                ? [message]
                : message.parts.length === 0
                  ? []
                  : [{ ...message, pending: false }]
            ),
            { id: next, role: 'assistant' as const, parts: [], pending: true }
          ]
        })),
        activeRuns: own !== undefined ? { ...state.activeRuns, [runId]: { ...own, messageId: next } } : state.activeRuns,
        mirrorRuns:
          mirror !== undefined ? { ...state.mirrorRuns, [runId]: { ...mirror, messageId: next } } : state.mirrorRuns
      }
    }),

  removeMessages: (sessionId, ids) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => ({
        ...session,
        messages: session.messages.filter((message) => !ids.includes(message.id))
      }))
    })),

  progressTool: (sessionId, toolUseId, text) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.parts.some((part) => part.kind === 'tool' && part.toolUseId === toolUseId && part.status === 'running')
            ? {
                ...message,
                parts: message.parts.map((part) =>
                  part.kind === 'tool' && part.toolUseId === toolUseId && part.status === 'running'
                    ? { ...part, output: part.output === '' ? text : `${part.output}\n${text}` }
                    : part
                )
              }
            : message
        )
      }))
    })),

  noticeInRun: (sessionId, messageId, text) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) =>
        mapMessage(session, messageId, (message) => ({
          ...message,
          parts: [...message.parts, { kind: 'notice', text }]
        }))
      )
    })),

  setContextTokens: (sessionId, tokens) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => ({ ...session, lastInputTokens: tokens }))
    })),

  addUsage: (sessionId, provider, model, inputTokens, outputTokens, eventKey, subagent, costUsd) =>
    set((state) => {
      if (eventKey !== undefined && state.seenUsageEvents.includes(eventKey)) return state
      const existing = state.usage.find(
        (entry) => entry.provider === provider && entry.model === model
      )
      const usage = existing
        ? state.usage.map((entry) =>
            entry === existing
              ? {
                  ...entry,
                  inputTokens: entry.inputTokens + inputTokens,
                  outputTokens: entry.outputTokens + outputTokens,
                  costUsd: (entry.costUsd ?? 0) + (costUsd ?? 0)
                }
              : entry
          )
        : [...state.usage, { provider, model, inputTokens, outputTokens, costUsd: costUsd ?? 0 }]

      return {
        seenUsageEvents: eventKey === undefined ? state.seenUsageEvents : [...state.seenUsageEvents, eventKey].slice(-2048),
        usage,
        sessions: mapSession(state, sessionId, (session) => ({
          ...session,
          inputTokens: session.inputTokens + inputTokens,
          outputTokens: session.outputTokens + outputTokens,
          costUsd: (session.costUsd ?? 0) + (costUsd ?? 0),
          ...(costUsd === null || costUsd === undefined ? { costPartial: true } : {}),
          ...(subagent === true ? {} : { provider, model, lastInputTokens: inputTokens })
        }))
      }
    }),

  settleMessage: (messageId, summary) =>
    set((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                pending: false,
                ...(summary !== undefined ? { summary } : {})
              }
            : message
        )
      }))
    })),

  setActiveRun: (run, runId) => set((state) => {
    const activeRuns = { ...state.activeRuns }
    if (run) activeRuns[run.runId] = run
    else if (runId) delete activeRuns[runId]
    return { activeRuns }
  }),

  addUserPrompt: (sessionId, text, attachments) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        const last = session.messages.at(-1)
        if (last?.role === 'user' && last.parts.some((part) => part.kind === 'text' && part.text === text)) {
          return session
        }
        const parts: MessagePart[] =
          attachments !== undefined && attachments.length > 0
            ? [{ kind: 'attachments', items: attachments }, { kind: 'text', text }]
            : [{ kind: 'text', text }]
        return {
          ...session,
          messages: [
            ...session.messages,
            { id: crypto.randomUUID(), role: 'user' as const, parts, pending: false }
          ]
        }
      })
    })),

  addNotice: (sessionId, text) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        const last = session.messages.at(-1)
        if (last?.parts.some((part) => part.kind === 'notice' && part.text === text)) {
          return session
        }
        return {
          ...session,
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              parts: [{ kind: 'notice' as const, text }],
              pending: false
            }
          ]
        }
      })
    })),

  // Mirrors what the main process just did to the real history: everything
  // from the last typed prompt onwards is gone, markers included.
  dropLastTurn: (sessionId) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          const message = session.messages[i]
          if (message?.role !== 'user') continue
          if (!message.parts.some((part) => part.kind === 'text')) continue
          return { ...session, messages: session.messages.slice(0, i) }
        }
        return session
      })
    })),

  dropFrom: (sessionId, messageId) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        const index = session.messages.findIndex((message) => message.id === messageId)
        return index < 0 ? session : { ...session, messages: session.messages.slice(0, index) }
      })
    })),

  dropAfter: (sessionId, messageId) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) => {
        const index = session.messages.findIndex((message) => message.id === messageId)
        return index < 0 ? session : { ...session, messages: session.messages.slice(0, index + 1) }
      })
    })),

  pauseSession: (sessionId) =>
    set((state) => ({
      pausedSessions: { ...state.pausedSessions, [sessionId]: true }
    })),

  resumeSession: (sessionId) =>
    set((state) => {
      const paused = { ...state.pausedSessions }
      delete paused[sessionId]
      return { pausedSessions: paused }
    })
}), {
  name: 'anticode-session-metadata',
  storage: createJSONStorage(() => (typeof window === 'undefined' ? sessionStoreMemoryStorage : window.localStorage)),
  skipHydration: typeof window === 'undefined',
  partialize: (state) => ({ followUpMode: state.followUpMode, diffLayout: state.diffLayout, drafts: Object.fromEntries(Object.entries(state.drafts).map(([id, draft]) => [id, { text: draft.text, attachments: [] }])), projects: state.projects, usage: state.usage, seenUsageEvents: state.seenUsageEvents, nextColour: state.nextColour,
    sessions: state.sessions.map((session) => ({ ...session, messages: [] })), activeSessionId: state.activeSessionId })
}))

export function useActiveSession(): Session | undefined {
  return useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId)
  )
}

// Debugging hook: lets CDP inspect the live session state in packaged builds.
if (typeof window !== 'undefined') window.__store = useSessionStore

/** The badge palette lives in the shared contract so the phone can match it. */
export { SESSION_COLOURS }
