import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AuthKind, AuthLoginState, ProviderId, ProviderInfo } from '@shared/ipc'

/*
 * Sign in to an OAuth vendor and use the account as a provider. Each account
 * shows up as a normal provider id (`auth:codex`, `auth:codex-2`, …) in the
 * composer and in Rotate usage, so two logins of the same vendor can be
 * rotated between like any other model.
 *
 * The token itself never reaches the renderer; only the label and the flow's
 * status do.
 */

interface Row {
  id: ProviderId
  label: string
  account?: string
  expiresAt?: number
  kind: AuthKind
}

const VENDORS: { kind: AuthKind; title: string; hint: string }[] = [
  {
    kind: 'codex',
    title: 'ChatGPT (Codex)',
    hint: 'Sign in with a ChatGPT Plus/Pro/Business account; Codex models run under your plan.'
  },
  { kind: 'claude', title: 'Claude Code', hint: 'Sign in with a Claude account and paste the code back.' },
  { kind: 'cline', title: 'Cline', hint: 'Sign in to your Cline account; the provider talks to api.cline.bot.' },
  {
    kind: 'codebuddy',
    title: 'CodeBuddy',
    hint: 'Sign in at codebuddy.ai; the account speaks OpenAI’s wire format.'
  }
]

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function when(timestamp: number | undefined): string {
  if (timestamp === undefined || timestamp === 0) return 'never'
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function Auth({ onProvidersChange }: { onProvidersChange: (list: ProviderInfo[]) => void }): JSX.Element {
  const [accounts, setAccounts] = useState<Row[]>([])
  const [flow, setFlow] = useState<AuthLoginState | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const list = await window.anticode.listAuthAccounts()
    setAccounts(
      list.map((a) => ({
        id: a.id,
        label: a.label,
        ...(a.account !== undefined ? { account: a.account } : {}),
        ...(a.expiresAt !== undefined ? { expiresAt: a.expiresAt } : {}),
        kind: a.kind
      }))
    )
    onProvidersChange(await window.anticode.listProviders())
  }

  useEffect(() => {
    void refresh()
    return window.anticode.onAuthLogin((state) => {
      setFlow(state)
      if (state.error !== undefined) setError(state.error)
      if (state.done) void refresh()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function start(kind: AuthKind): Promise<void> {
    setError(null)
    setCode('')
    try {
      setFlow(await window.anticode.startAuthLogin(kind))
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function submit(): Promise<void> {
    if (flow === null) return
    try {
      await window.anticode.submitAuthCode(flow.id, code)
      setCode('')
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function remove(id: ProviderId): Promise<void> {
    try {
      await window.anticode.removeAuthProvider(id)
      await refresh()
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Auth provider</h1>

      <p className="mb-6 max-w-prose text-[12.5px] leading-relaxed text-faint">
        Sign in with an account instead of an API key. Each account is added as a provider
        (<span className="text-dim">auth:codex</span>,{' '}
        <span className="text-dim">auth:claude</span>) and can be picked in the composer or added to
        Rotate usage by name.
      </p>

      <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line">
        {VENDORS.map((vendor, index) => (
          <div
            key={vendor.kind}
            className={`flex items-center gap-6 px-5 py-4 ${index === VENDORS.length - 1 ? '' : 'border-b border-line-soft'}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-text">{vendor.title}</div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{vendor.hint}</div>
            </div>
            <button
              type="button"
              onClick={() => void start(vendor.kind)}
              className="glass-control shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
            >
              Sign in
            </button>
          </div>
        ))}
      </div>

      {flow !== null && !flow.done && (
        <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line px-5 py-4">
          <div className="text-[13.5px] text-text">{flow.status}</div>
          {flow.url !== undefined && (
            <a
              href={flow.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block break-all text-[12px] text-dim transition-colors hover:text-brand"
            >
              {flow.url}
            </a>
          )}
          {flow.needsCode && (
            <div className="mt-3 flex items-center gap-2">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="Paste the authorization code"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-text outline-none focus:border-brand"
              />
              <button
                type="button"
                disabled={code.trim() === ''}
                onClick={() => void submit()}
                className="glass-control shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
              >
                Submit
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              void window.anticode.cancelAuthLogin(flow.id)
              setFlow(null)
            }}
            className="mt-3 text-[12px] text-dim transition-colors hover:text-del"
          >
            Cancel
          </button>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="glass-surface rounded-xl border border-line px-5 py-4 text-[12.5px] text-faint">
          No accounts yet.
        </div>
      ) : (
        <div className="glass-surface overflow-hidden rounded-xl border border-line">
          {accounts.map((row, index) => (
            <div
              key={row.id}
              className={`flex items-center gap-6 px-5 py-4 ${index === accounts.length - 1 ? '' : 'border-b border-line-soft'}`}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] text-text">{row.label}</div>
                <div className="mt-0.5 text-[12.5px] text-faint">
                  {row.id}
                  {row.expiresAt !== undefined ? ` · token expires ${when(row.expiresAt)}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void remove(row.id)}
                className="shrink-0 text-[12.5px] text-dim transition-colors hover:text-del"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {error !== null && <p className="mt-4 text-[12.5px] text-del">{error}</p>}
    </>
  )
}