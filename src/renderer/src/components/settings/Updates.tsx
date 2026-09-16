import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UpdateState } from '@shared/ipc'
import { SettingRow, Toggle } from './controls'

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function when(timestamp: number | null): string {
  if (timestamp === null) return 'never'
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Where updates come from and what happens with them. Checking and
 * downloading may run on their own; installing never does — it quits the app,
 * so it waits for the button.
 */
export function Updates(): JSX.Element {
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.anticode.getUpdateState().then(setState)
    return window.anticode.onUpdateState(setState)
  }, [])

  async function act(action: () => Promise<UpdateState | void>): Promise<void> {
    setError(null)
    try {
      const next = await action()
      if (next !== undefined) setState(next)
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  const status = state?.status ?? 'idle'
  const busy = status === 'checking' || status === 'downloading'
  const line =
    state === null
      ? '…'
      : status === 'checking'
        ? 'Checking…'
        : status === 'downloading'
          ? `Downloading ${state.latest ?? ''} · ${Math.round((state.progress ?? 0) * 100)}%`
          : status === 'ready'
            ? `Version ${state.latest ?? ''} is downloaded and ready`
            : status === 'available'
              ? `Version ${state.latest ?? ''} is available`
              : status === 'current'
                ? `Up to date${state.latest !== null ? ` · newest is ${state.latest}` : ''}`
                : status === 'error'
                  ? (state.error ?? 'The last check failed')
                  : 'Not checked yet'

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Updates</h1>

      <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line">
        <SettingRow title="Check automatically" hint="At start-up and every six hours">
          <Toggle
            on={state?.autoCheck === true}
            onChange={(value) => void act(() => window.anticode.configureUpdates({ autoCheck: value }))}
          />
        </SettingRow>
        <SettingRow title="Download automatically" hint="Fetch a newer build as soon as it is found. Installing always waits for you.">
          <Toggle
            on={state?.autoDownload === true}
            onChange={(value) => void act(() => window.anticode.configureUpdates({ autoDownload: value }))}
          />
        </SettingRow>
      </div>

      <div className="glass-surface overflow-hidden rounded-xl border border-line px-5 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13.5px] text-text">anticode {state?.current ?? ''}</div>
            <div className={`mt-0.5 text-[12.5px] ${status === 'error' ? 'text-del' : 'text-faint'}`}>{line}</div>
          </div>
          <div className="shrink-0 text-[11.5px] text-faint">Last checked {when(state?.checkedAt ?? null)}</div>
        </div>

        <div className="mt-3 h-1 overflow-hidden rounded-full bg-raised">
          <div
            className={`h-full rounded-full bg-add transition-[width] ${status === 'downloading' || status === 'ready' ? '' : 'invisible'}`}
            style={{ width: `${Math.round((state?.progress ?? 0) * 100)}%` }}
          />
        </div>

        {state?.notes !== null && state?.notes !== undefined && state.notes.trim() !== '' && (
          <pre className="mt-3 max-h-40 overflow-y-auto rounded-lg border border-line bg-surface px-3 py-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-dim">
            {state.notes}
          </pre>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => window.anticode.checkForUpdates())}
            className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
          >
            Check now
          </button>
          {status === 'available' && (
            <button
              type="button"
              onClick={() => void act(() => window.anticode.downloadUpdate())}
              className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
            >
              Download {state?.latest}
            </button>
          )}
          {status === 'ready' &&
            (state?.canInstall === true ? (
              confirming ? (
                <>
                  <span className="text-[12px] text-faint">anticode quits; runs in progress are paused.</span>
                  <button
                    type="button"
                    onClick={() => void act(() => window.anticode.installUpdate())}
                    className="rounded-lg bg-brand px-3 py-1.5 text-[12.5px] text-bg transition-colors hover:bg-brand-strong"
                  >
                    Restart now
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:text-brand"
                  >
                    Later
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
                >
                  Restart to update
                </button>
              )
            ) : (
              <span className="text-[12px] text-faint">This is a development run; install the packaged app to update.</span>
            ))}
        </div>
        {error !== null && <p className="mt-3 text-[12.5px] text-del">{error}</p>}
      </div>
    </>
  )
}
