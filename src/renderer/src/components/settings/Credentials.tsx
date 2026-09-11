import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CredentialStatus } from '@shared/ipc'

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/**
 * Where the keys live. Settings keys are sealed with the keychain; keys in the
 * .env file are plaintext in a file the user owns, so this shows which ones
 * are there and offers — never forces — moving them into sealed storage.
 */
export function Credentials({ onChanged }: { onChanged: () => void }): JSX.Element | null {
  const [status, setStatus] = useState<CredentialStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.anticode.getCredentialStatus().then(setStatus)
  }, [])

  async function act(action: () => Promise<CredentialStatus>): Promise<void> {
    setError(null)
    try {
      setStatus(await action())
      onChanged()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  if (status === null || (status.secureStorage && status.envKeys.length === 0)) return null
  const movable = status.envKeys.filter((key) => key.movable)

  return (
    <div className="glass-surface mb-8 overflow-hidden rounded-xl border border-line px-5 py-4" data-credentials>
      <div className="text-[13.5px] text-text">Credentials</div>
      {!status.secureStorage && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-del">
          This system has no secure storage, so keys typed here work until anticode quits and are not saved.
        </p>
      )}
      {status.envKeys.length > 0 && status.envFile !== null && (
        <>
          <p className="mt-1 text-[12.5px] leading-relaxed text-faint">
            These keys are read from <span className="font-mono text-dim">{status.envFile}</span> as plain text. Keys typed
            in Settings are sealed with the system keychain instead.
          </p>
          <ul className="mt-2">
            {status.envKeys.map((key) => (
              <li key={key.name} className="flex items-baseline gap-3 py-0.5 text-[12.5px]">
                <span className="font-mono text-dim">{key.name}</span>
                <span className="font-mono text-faint">{key.masked}</span>
                <span className="text-[11.5px] text-faint">{key.usedBy !== null ? `used by ${key.usedBy}` : 'not used by anticode'}</span>
              </li>
            ))}
          </ul>
          {status.envFileOpen && (
            <p className="mt-2 text-[12px] text-del">Other accounts on this computer can read that file.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {movable.length > 0 &&
              (confirming ? (
                <>
                  <span className="text-[12px] text-faint">
                    {movable.map((key) => key.name).join(', ')} will be sealed here and commented out of the file.
                  </span>
                  <button
                    type="button"
                    onClick={() => void act(() => window.anticode.moveEnvCredentials()).then(() => setConfirming(false))}
                    className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
                  >
                    Move
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:text-brand"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!status.secureStorage}
                  onClick={() => setConfirming(true)}
                  className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
                >
                  Move to secure storage
                </button>
              ))}
            {status.envFileOpen && (
              <button
                type="button"
                onClick={() => void act(() => window.anticode.restrictEnvFile())}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:text-brand"
              >
                Make it readable only by me
              </button>
            )}
          </div>
        </>
      )}
      {error !== null && <p className="mt-2 text-[12px] text-del">{error}</p>}
    </div>
  )
}
