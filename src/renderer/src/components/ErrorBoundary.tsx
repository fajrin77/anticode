import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface BoundaryProps {
  children: ReactNode
  /** Changing this value clears the error state; used by the retry flow. */
  resetKey?: string
}

interface BoundaryState {
  error: Error | null
  /** Crash timestamps, kept in localStorage so repeated crashes are visible across reloads. */
  crashes: number[]
}

const CRASH_KEY = 'anticode.renderer.crashes'
/** A renderer that crashes again within 30s is looping; those loops skip the heavy restore. */
const LOOP_WINDOW_MS = 30_000
const MAX_CRASH_MARKERS = 5

const readCrashes = (): number[] => {
  try {
    const raw = window.localStorage.getItem(CRASH_KEY)
    return raw !== null ? (JSON.parse(raw) as number[]) : []
  } catch {
    return []
  }
}

const writeCrashes = (crashes: number[]): void => {
  try {
    window.localStorage.setItem(CRASH_KEY, JSON.stringify(crashes.slice(-MAX_CRASH_MARKERS)))
  } catch {
    // localStorage may be unavailable right after a crash; the boundary still works.
  }
}

const clearCrashes = (): void => {
  try {
    window.localStorage.removeItem(CRASH_KEY)
  } catch {
    // ignore
  }
}

/**
 * Last line of defence for the renderer. Without this, one uncaught render
 * error unmounts #root and the user sees a silent blank window; with it the
 * same failure shows the message plus a way forward. Repeated crashes mark
 * the session as crashing so callers can skip the restore that likely caused
 * the loop (see main.tsx).
 */
export class ErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, crashes: readCrashes() }

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const crashes = [...this.state.crashes, Date.now()].slice(-MAX_CRASH_MARKERS)
    writeCrashes(crashes)
    this.setState({ crashes })
    // Landing in localStorage means the next instance can see the loop even
    // after a full reload; also surface it in the devtools console.
    console.error('[anticode] renderer crash captured by boundary:', error, info.componentStack)
  }

  componentDidUpdate(previous: BoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    const { error, crashes } = this.state
    if (error === null) return this.props.children
    const latest = crashes[crashes.length - 1]
    const looping = latest !== undefined && crashes.length >= 3 && latest - (crashes[0] ?? latest) <= LOOP_WINDOW_MS
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
        <div className="max-w-xl space-y-2">
          <p className="text-[15px] font-medium text-text">Tampilan gagal dirender</p>
          <p className="text-[13px] text-dim">
            Sesi Anda tetap aman di proses utama. Aplikasi biasanya pulih dengan dimuat ulang.
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-raised p-3 text-left text-[12px] text-del">
            {error.message}
            {error.stack !== undefined ? `\n\n${error.stack.split('\n').slice(0, 6).join('\n')}` : null}
          </pre>
          {looping ? <p className="text-[12px] text-faint">Tiga kali gagal dalam 30 detik — recover mode menyala.</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => location.reload()}
            className="rounded-md px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-raised hover:text-brand"
          >
            Muat ulang
          </button>
          <button
            type="button"
            onClick={() => {
              clearCrashes()
              // Recovery: without the snapshot replay the app opens on a clean
              // dashboard; data stays in main, it is only not restored here.
              location.hash = '#recover'
              location.reload()
            }}
            className="rounded-md px-3 py-1.5 text-[13px] text-dim transition-colors hover:bg-raised hover:text-brand"
          >
            Muat ulang tanpa pemulihan sesi
          </button>
        </div>
      </div>
    )
  }
}

/** True when the app was asked to open without replaying persisted state. */
export const isRecoveryMode = (): boolean => window.location.hash === '#recover'
