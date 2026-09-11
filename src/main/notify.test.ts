import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  focused: null as unknown,
  shown: [] as { title: string; body: string; silent: boolean }[],
  handlers: [] as Record<string, () => void>[],
  prefs: { enabled: true, complete: true, error: true, approval: true, update: true, sound: true, background: true },
  focusedSession: [] as string[]
}))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => state.focused },
  Notification: class {
    static isSupported(): boolean { return true }
    private readonly on_: Record<string, () => void> = {}
    constructor(private readonly options: { title: string; body: string; silent: boolean }) { state.handlers.push(this.on_) }
    on(event: string, handler: () => void): void { this.on_[event] = handler }
    show(): void { state.shown.push(this.options) }
  }
}))
vi.mock('./preferences', () => ({ preferences: () => ({ notifications: state.prefs }) }))
vi.mock('./windows', () => ({ focusSession: (id: string) => state.focusedSession.push(id), showMainWindow: () => undefined }))

import { notify } from './notify'

beforeEach(() => {
  state.focused = null
  state.shown = []
  state.handlers = []
  state.focusedSession = []
  state.prefs = { enabled: true, complete: true, error: true, approval: true, update: true, sound: true, background: true }
})

it('shows a kind that is switched on, and a click opens its session', () => {
  notify('complete', { title: 'halo', body: 'Finished.', sessionId: 's1' })
  expect(state.shown).toEqual([{ title: 'halo', body: 'Finished.', silent: false }])
  state.handlers[0]?.['click']?.()
  expect(state.focusedSession).toEqual(['s1'])
})

it('stays quiet for a muted kind, when everything is muted, or while anticode is in front', () => {
  state.prefs.approval = false
  notify('approval', { title: 'a', body: 'b' })
  state.prefs.approval = true
  state.prefs.enabled = false
  notify('approval', { title: 'a', body: 'b' })
  state.prefs.enabled = true
  state.focused = {}
  notify('error', { title: 'a', body: 'b' })
  expect(state.shown).toEqual([])
  state.prefs.background = false
  state.prefs.sound = false
  notify('error', { title: 'a', body: 'b' })
  expect(state.shown).toEqual([{ title: 'a', body: 'b', silent: true }])
})
