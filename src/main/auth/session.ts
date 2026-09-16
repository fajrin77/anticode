import { BrowserWindow } from 'electron'
import { IpcChannel } from '@shared/ipc'
import type { AuthLoginState } from '@shared/ipc'
import { loginAuthAccount } from './index'
import type { AuthKind } from './types'

/*
 * Runs the vendor logins the Settings → Auth provider panel asks for. One
 * flow at a time per id; every update is broadcast on AUTH_EVENT so both the
 * desktop window and the phone can follow along and a second click cannot
 * start a duplicate. A paste-code flow (Claude) parks here until the renderer
 * hands the code back through submitAuthCode.
 */

interface Running {
  state: AuthLoginState
  abort: AbortController
  /** Resolved by submitAuthCode with the pasted code. */
  resolveCode: ((code: string) => void) | null
}

const running = new Map<string, Running>()

function broadcast(state: AuthLoginState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.AUTH_EVENT, state)
  }
}

function nextId(kind: AuthKind): string {
  let n = 1
  while (running.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

/**
 * Starts the login and returns the opening state at once; the rest of the
 * flow reports through onAuthLogin. A second call while one is in flight for
 * the same kind is refused — the browser tab is already open.
 */
export function startAuthLogin(kind: AuthKind): AuthLoginState {
  for (const entry of running.values()) {
    if (entry.state.kind === kind && !entry.state.done && entry.state.error === undefined) {
      return entry.state
    }
  }

  const id = nextId(kind)
  const controller = new AbortController()
  const initial: AuthLoginState = {
    id,
    kind,
    status: 'Starting…',
    needsCode: false,
    done: false
  }
  const entry: Running = { state: initial, abort: controller, resolveCode: null }
  running.set(id, entry)

  const update = (patch: Partial<AuthLoginState>): void => {
    entry.state = { ...entry.state, ...patch }
    broadcast(entry.state)
  }

  void (async () => {
    try {
      const account = await loginAuthAccount(kind, {
        onUpdate: (u) => {
          const url = u.url ?? entry.state.url
          update({
            status: u.message,
            ...(url !== undefined ? { url } : {}),
            needsCode: u.needsCode === true || entry.state.needsCode,
            done: u.done === true
          })
        },
        promptForCode: (message) =>
          new Promise<string>((resolve) => {
            entry.resolveCode = resolve
            update({ status: message, needsCode: true })
          })
      })
      update({
        status: 'Signed in',
        done: true,
        accountId: account.id,
        label: account.label,
        needsCode: false
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      update({ status: message, error: message, done: false, needsCode: false })
    } finally {
      // Keep the final state around briefly so a late window can read it; a
      // fresh login of the same kind still works because it keys on `done`.
      setTimeout(() => running.delete(id), 30_000).unref?.()
    }
  })()

  broadcast(initial)
  return initial
}

/** Hands the pasted authorization code to the waiting Claude flow. */
export function submitAuthCode(id: string, code: string): void {
  const entry = running.get(id)
  if (entry === undefined || entry.resolveCode === null) return
  const resolve = entry.resolveCode
  entry.resolveCode = null
  entry.state = { ...entry.state, needsCode: false, status: 'Exchanging the code…' }
  broadcast(entry.state)
  resolve(code)
}

/** Gives up on a running login; the local listener and the wait are torn down. */
export function cancelAuthLogin(id: string): void {
  const entry = running.get(id)
  if (entry === undefined) return
  entry.abort.abort()
  // A Claude flow parked on promptForCode never sees the abort; unblock it so
  // the promise rejects with an empty code and the flow ends.
  entry.resolveCode?.('')
  entry.resolveCode = null
  running.delete(id)
  broadcast({ ...entry.state, status: 'Cancelled', error: 'Cancelled', done: false })
}

/** For tests: forget every running flow. */
export function resetAuthSessionsForTests(): void {
  running.clear()
}