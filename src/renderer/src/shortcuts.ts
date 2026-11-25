import { sidebarProjectOrder } from './store/session'
import type { Session } from './store/session'

/**
 * Every keyboard shortcut the app answers to, in one list: Settings →
 * Shortcuts renders it, and the handlers in App, Composer and SessionView
 * implement it. A shortcut added in code belongs here too, or nobody finds it.
 *
 * `Mod` is ⌘ on macOS and Ctrl elsewhere. Each entry may offer alternatives.
 */
export interface Shortcut {
  keys: string[][]
  action: string
}

export interface ShortcutGroup {
  title: string
  hint?: string
  items: Shortcut[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Anywhere in the app',
    items: [
      { keys: [['Mod', 'N']], action: 'New session' },
      { keys: [['Mod', 'K']], action: 'Switch session' },
      { keys: [['Mod', '1…9']], action: 'Go to session 1–9 in sidebar order' },
      { keys: [['Ctrl', 'Tab'], ['Mod', 'Shift', ']']], action: 'Next session' },
      { keys: [['Ctrl', 'Shift', 'Tab'], ['Mod', 'Shift', '[']], action: 'Previous session' },
      { keys: [['Mod', 'W']], action: 'Close the session tab (it stays in the sidebar archive)' },
      { keys: [['Mod', 'Shift', 'T']], action: 'Reopen the tab closed last' },
      { keys: [['Mod', 'B']], action: 'Show or hide the sidebar' },
      { keys: [['Mod', ',']], action: 'Open or close Settings' },
      { keys: [['Mod', '/']], action: 'Show this list' }
    ]
  },
  {
    title: 'In a session',
    items: [
      { keys: [['Esc'], ['Mod', '.']], action: 'Pause the run in progress' },
      { keys: [['Mod', 'F']], action: 'Find in the transcript (Enter next, Shift+Enter previous)' },
      { keys: [['Mod', 'L']], action: 'Put the cursor in the prompt box' },
      { keys: [['Mod', 'J']], action: 'Show or hide terminal output (code sessions)' },
      { keys: [['Mod', 'Shift', 'M']], action: 'Choose the model' },
      { keys: [['Mod', 'Shift', 'E']], action: 'Choose the effort level (models that have one)' },
      { keys: [['Mod', 'Shift', 'C']], action: 'Copy the latest reply' }
    ]
  },
  {
    title: 'In the prompt box',
    items: [
      { keys: [['Enter']], action: 'Send; while a run works, steer or queue as the chip says' },
      { keys: [['Shift', 'Enter']], action: 'New line' },
      { keys: [['Mod', 'Enter']], action: 'While a run works: the other follow-up mode' },
      { keys: [['↑'], ['↓']], action: 'Earlier prompts, with the cursor at the start' },
      { keys: [['@']], action: 'Mention a file from the workspace' },
      { keys: [['/plan']], action: 'Switch plan mode on or off' },
      { keys: [['/compact']], action: 'Compact the conversation' }
    ]
  },
  {
    title: 'System-wide',
    hint: 'Work while another app is in front.',
    items: [
      { keys: [['Mod', 'Shift', 'Space']], action: 'Bring anticode to the front' },
      { keys: [['Mod', 'Alt', 'Space']], action: 'Quick capture' }
    ]
  }
]

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** How a key token reads on this platform. */
export function keyLabel(token: string, mac = isMac()): string {
  if (token === 'Mod') return mac ? '⌘' : 'Ctrl'
  if (token === 'Shift') return mac ? '⇧' : 'Shift'
  if (token === 'Alt') return mac ? '⌥' : 'Alt'
  if (token === 'Ctrl') return mac ? '⌃' : 'Ctrl'
  return token
}

/** Open sessions in the order the sidebar lists them: by project, then as created. */
export function sessionOrder(state: { projectOrder: string[]; sessions: Session[] }): Session[] {
  const open = state.sessions.filter((session) => !session.closed)
  const key = (session: Session): string => (session.mode === 'chat' ? 'antichat' : session.projectRoot ?? '')
  return sidebarProjectOrder({ projectOrder: state.projectOrder, sessions: open })
    .flatMap((root) => open.filter((session) => key(session) === root))
}

/** The session `step` places away from `current`, wrapping around; null when there is nowhere to go. */
export function neighbourSession(order: Session[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null
  const index = order.findIndex((session) => session.id === current)
  if (index === -1) return order[step === 1 ? 0 : order.length - 1]!.id
  if (order.length === 1) return null
  return order[(index + step + order.length) % order.length]!.id
}

/** The last thing the assistant said in this session, for copying. */
export function latestReply(session: Session | undefined): string {
  for (const message of [...(session?.messages ?? [])].reverse()) {
    if (message.role !== 'assistant' || message.pending) continue
    const text = message.parts.findLast((part) => part.kind === 'text' && part.text.trim() !== '')
    if (text?.kind === 'text') return text.text.trim()
  }
  return ''
}

/** Asks the composer on screen to open one of its menus. */
export const COMPOSER_MENU_EVENT = 'anticode:composer-menu'
export function openComposerMenu(menu: 'model' | 'effort'): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_MENU_EVENT, { detail: menu }))
}
