import { create } from 'zustand'
import type { SessionMode, SessionSpec, SnapshotMessage } from '@shared/ipc'

export type Role = 'user' | 'assistant'
export type ToolStatus = 'running' | 'ok' | 'error'

export type MessagePart =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      input: unknown
      status: ToolStatus
      output: string
    }

export interface RunSummary {
  model: string
  durationMs: number
}

export interface Message {
  id: string
  role: Role
  parts: MessagePart[]
  pending: boolean
  /** Set when the run settles; feeds the closing summary card. */
  summary?: RunSummary
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
  /**
   * Closing a tab only hides it: the session (with its whole transcript)
   * stays in the dashboard until the user reopens or a new app run replaces it.
   */
  closed: boolean
  /** Index into SESSION_COLOURS; assigned round-robin at creation. */
  colour: number
}

export interface UsageEntry {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface ActiveRun {
  runId: string
  messageId: string
  /** The session that owns this run; events must land there, not in the open tab. */
  sessionId: string
  startedAt: number
}

interface SessionState {
  projects: Project[]
  sessions: Session[]
  /** Running totals per provider+model, kept across sessions for the dashboard. */
  usage: UsageEntry[]
  activeSessionId: string | null
  activeRun: ActiveRun | null
  /** Phone-initiated runs mirrored live here: runId → placeholder message. */
  mirrorRuns: Record<string, { sessionId: string; messageId: string; startedAt: number }>
  /** Next badge-colour index; advances on every session creation. */
  nextColour: number

  addProject: (root: string) => void
  openSession: (mode: SessionMode, projectRoot: string | null) => string
  selectSession: (id: string) => void
  /** Reopens a closed session's tab and makes it active. */
  reopenSession: (id: string) => void
  /** Removes a session everywhere: tab, dashboard, and history. */
  deleteSession: (id: string) => void
  /** Registers a session created elsewhere (the remote phone app). */
  addExternalSession: (spec: SessionSpec) => void
  /** Fills a registered external session with its main-process transcript. */
  importSnapshot: (sessionId: string, messages: SnapshotMessage[]) => void
  /** Puts the closing summary on the newest assistant message (post-import). */
  stampLastSummary: (sessionId: string, summary: RunSummary) => void
  /** Opens a live mirror placeholder for a phone-initiated run; returns its message id. */
  mirrorStart: (runId: string, sessionId: string) => string
  /** Closes a mirror placeholder once the mirrored run settles. */
  mirrorSettle: (runId: string, summary?: RunSummary) => void
  /** Sets mode and project folder on a fresh session before its first prompt. */
  updateSessionConfig: (
    id: string,
    patch: { mode?: SessionMode; projectRoot?: string | null }
  ) => void
  closeSession: (id: string) => void

  addMessage: (message: Message) => void
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
    output: string
  ) => void
  addUsage: (
    sessionId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ) => void
  settleMessage: (messageId: string, summary?: RunSummary) => void
  setActiveRun: (run: ActiveRun | null) => void
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

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: [],
  sessions: [],
  usage: [],
  activeSessionId: null,
  activeRun: null,
  mirrorRuns: {},
  nextColour: 0,

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

  // A fresh session starts as an unnamed chat; picking anticode binds the
  // folder and renames the tab to it, chat renames from the first prompt.
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
      if (state.sessions.some((session) => session.id === spec.sessionId)) return state
      const session: Session = {
        id: spec.sessionId,
        title:
          spec.mode === 'code' && spec.workspaceRoot !== null
            ? baseName(spec.workspaceRoot)
            : 'New session',
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
        colour: state.nextColour
      }
      return {
        sessions: [...state.sessions, session],
        nextColour: (state.nextColour + 1) % SESSION_COLOURS.length
      }
    }),

  // Converts the main-process transcript into renderer message parts.
  importSnapshot: (sessionId, messages) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        const converted: Message[] = []
        for (const message of messages) {
          const parts: MessagePart[] = []
          for (const block of message.blocks) {
            if (block.type === 'text') {
              parts.push({ kind: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              parts.push({
                kind: 'tool',
                toolUseId: block.id,
                name: block.name,
                input: block.input,
                status: 'ok',
                output: ''
              })
            } else {
              for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i]
                if (part === undefined) continue
                if (part.kind === 'tool' && part.toolUseId === block.toolUseId) {
                  part.output = block.content
                  part.status = block.isError ? 'error' : 'ok'
                  break
                }
              }
            }
          }
          converted.push({
            id: crypto.randomUUID(),
            role: message.role,
            parts,
            pending: false
          })
        }
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
      return { sessions: remaining, activeSessionId }
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
      sessions: mapActive(state, (session) => ({
        ...session,
        title:
          session.messages.length === 0 && message.role === 'user' && session.mode === 'chat'
            ? (message.parts.find((part) => part.kind === 'text')?.text ?? session.title)
                .slice(0, 60)
            : session.title,
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

  endTool: (sessionId, messageId, toolUseId, ok, output) =>
    set((state) => ({
      sessions: mapSession(state, sessionId, (session) =>
        mapMessage(session, messageId, (message) => ({
          ...message,
          parts: message.parts.map((part) =>
            part.kind === 'tool' && part.toolUseId === toolUseId
              ? { ...part, status: ok ? 'ok' : 'error', output }
              : part
          )
        }))
      )
    })),

  addUsage: (sessionId, provider, model, inputTokens, outputTokens) =>
    set((state) => {
      const existing = state.usage.find(
        (entry) => entry.provider === provider && entry.model === model
      )
      const usage = existing
        ? state.usage.map((entry) =>
            entry === existing
              ? {
                  ...entry,
                  inputTokens: entry.inputTokens + inputTokens,
                  outputTokens: entry.outputTokens + outputTokens
                }
              : entry
          )
        : [...state.usage, { provider, model, inputTokens, outputTokens }]

      return {
        usage,
        sessions: mapSession(state, sessionId, (session) => ({
          ...session,
          inputTokens: session.inputTokens + inputTokens,
          outputTokens: session.outputTokens + outputTokens,
          provider,
          model,
          lastInputTokens: inputTokens
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

  setActiveRun: (run) => set({ activeRun: run })
}))

export function useActiveSession(): Session | undefined {
  return useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId)
  )
}

/**
 * Ordered glass gradients for session badges. Sessions take the next entry on
 * creation, so fresh sessions are visually distinct until the palette wraps.
 */
export const SESSION_COLOURS: [string, string][] = [
  ['#7a5cc4', '#4f3a8f'],
  ['#3f8f86', '#2c6b64'],
  ['#c2603f', '#8f4630'],
  ['#3f7fc2', '#2c5e92'],
  ['#b0873a', '#82632c'],
  ['#8f4f7a', '#6a3c5c'],
  ['#4f8f4f', '#386b38'],
  ['#c24f7a', '#923a5c'],
  ['#5c7ac2', '#43598f'],
  ['#c27a3f', '#925c30']
]
