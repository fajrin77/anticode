import { create } from 'zustand'
import type { SessionMode } from '@shared/ipc'

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

export interface Message {
  id: string
  role: Role
  parts: MessagePart[]
  pending: boolean
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
}

interface SessionState {
  projects: Project[]
  sessions: Session[]
  /** Running totals per provider+model, kept across sessions for the dashboard. */
  usage: UsageEntry[]
  activeSessionId: string | null
  activeRun: ActiveRun | null

  addProject: (root: string) => void
  openSession: (mode: SessionMode, projectRoot: string | null) => string
  selectSession: (id: string) => void
  closeSession: (id: string) => void

  addMessage: (message: Message) => void
  appendText: (messageId: string, text: string) => void
  startTool: (messageId: string, toolUseId: string, name: string, input: unknown) => void
  endTool: (messageId: string, toolUseId: string, ok: boolean, output: string) => void
  addUsage: (provider: string, model: string, inputTokens: number, outputTokens: number) => void
  settleMessage: (messageId: string) => void
  setActiveRun: (run: ActiveRun | null) => void
}

function baseName(root: string): string {
  const parts = root.split('/').filter((part) => part !== '')
  return parts.at(-1) ?? root
}

function newSession(mode: SessionMode, projectRoot: string | null): Session {
  return {
    id: crypto.randomUUID(),
    title: mode === 'chat' ? 'antichat baru' : 'anticode baru',
    mode,
    projectRoot,
    createdAt: Date.now(),
    messages: [],
    inputTokens: 0,
    outputTokens: 0
  }
}

function mapActive(state: SessionState, change: (session: Session) => Session): Session[] {
  return state.sessions.map((session) =>
    session.id === state.activeSessionId ? change(session) : session
  )
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

export const useSessionStore = create<SessionState>((set) => ({
  projects: [],
  sessions: [],
  usage: [],
  activeSessionId: null,
  activeRun: null,

  addProject: (root) =>
    set((state) =>
      state.projects.some((project) => project.root === root)
        ? state
        : { projects: [...state.projects, { root, name: baseName(root) }] }
    ),

  openSession: (mode, projectRoot) => {
    const session = newSession(mode, projectRoot)
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id
    }))
    return session.id
  },

  selectSession: (id) => set({ activeSessionId: id }),

  closeSession: (id) =>
    set((state) => {
      const remaining = state.sessions.filter((session) => session.id !== id)
      const activeSessionId =
        state.activeSessionId === id ? (remaining.at(-1)?.id ?? null) : state.activeSessionId
      return { sessions: remaining, activeSessionId }
    }),

  addMessage: (message) =>
    set((state) => ({
      sessions: mapActive(state, (session) => ({
        ...session,
        title:
          session.messages.length === 0 && message.role === 'user'
            ? (message.parts.find((part) => part.kind === 'text')?.text ?? session.title)
                .slice(0, 60)
            : session.title,
        messages: [...session.messages, message]
      }))
    })),

  appendText: (messageId, text) =>
    set((state) => ({
      sessions: mapActive(state, (session) =>
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

  startTool: (messageId, toolUseId, name, input) =>
    set((state) => ({
      sessions: mapActive(state, (session) =>
        mapMessage(session, messageId, (message) => ({
          ...message,
          parts: [
            ...message.parts,
            { kind: 'tool', toolUseId, name, input, status: 'running', output: '' }
          ]
        }))
      )
    })),

  endTool: (messageId, toolUseId, ok, output) =>
    set((state) => ({
      sessions: mapActive(state, (session) =>
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

  addUsage: (provider, model, inputTokens, outputTokens) =>
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
        sessions: mapActive(state, (session) => ({
          ...session,
          inputTokens: session.inputTokens + inputTokens,
          outputTokens: session.outputTokens + outputTokens
        }))
      }
    }),

  settleMessage: (messageId) =>
    set((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: session.messages.map((message) =>
          message.id === messageId ? { ...message, pending: false } : message
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

const BADGE_COLOURS = ['#c2603f', '#3f8f86', '#7a5cc4', '#3f7fc2', '#b0873a', '#8f4f7a']

export function badgeColour(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return BADGE_COLOURS[hash % BADGE_COLOURS.length] ?? BADGE_COLOURS[0]!
}
