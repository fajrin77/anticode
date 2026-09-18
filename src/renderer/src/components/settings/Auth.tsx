import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AuthAccountSummary, AuthKind, AuthLoginState, ProviderInfo } from '@shared/ipc'

/*
 * Sign in to an OAuth vendor and use the account as a provider. Each account
 * shows up as a normal provider id (`auth:codex`, `auth:codex-2`, …) in the
 * composer and in Rotate usage, so two logins of the same vendor can be
 * rotated between like any other model.
 *
 * The token itself never reaches the renderer; the panel sees only the label,
 * when the token dies, and whether its seal still opens.
 */

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

/** CodeBuddy hands out a long-lived token and offers no refresh grant. */
const RENEWABLE: Record<AuthKind, boolean> = {
  codex: true,
  claude: true,
  cline: true,
  codebuddy: false
}

const TICK_MS = 30_000
/** Under this the panel says renew; the chat side renews at five minutes. */
const SOON_MS = 15 * 60 * 1000

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function absolute(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/**
 * What an account says about its token, beside its name. Short enough to sit
 * on one line next to the label, the long version is the `title`, because
 * the only thing that must never be cut off is whether the account still
 * works. A token that renews itself needs no attention; one that cannot be
 * renewed has to say so before a turn fails mid-answer.
 */
function tokenState(
  row: AuthAccountSummary,
  now: number
): { text: string; title: string; tone: string } {
  if (!row.usable) {
    return {
      text: 'sign in again',
      title: 'The sealed token cannot be opened by this keychain, so the account cannot answer a turn.',
      tone: 'text-del'
    }
  }
  if (row.expiresAt === undefined || row.expiresAt === 0) {
    return {
      text: 'long-lived',
      title: 'The vendor did not say when this token dies.',
      tone: 'text-faint'
    }
  }
  const left = row.expiresAt - now
  if (left <= 0) {
    return row.refreshable
      ? { text: 'renews next turn', title: `Expired ${absolute(row.expiresAt)}; the next turn renews it.`, tone: 'text-dim' }
      : { text: 'expired', title: `Expired ${absolute(row.expiresAt)}. Sign in again.`, tone: 'text-del' }
  }
  if (left < SOON_MS && !row.refreshable) {
    return {
      text: `runs out in ${span(left)}`,
      title: `Expires ${absolute(row.expiresAt)} and cannot be renewed. Sign in again.`,
      tone: 'text-del'
    }
  }
  return {
    text: left < 24 * 60 * 60 * 1000 ? `good for ${span(left)}` : 'good',
    title: `Expires ${absolute(row.expiresAt)}.`,
    tone: 'text-faint'
  }
}

export function Auth({
  providers,
  onProvidersChange
}: {
  providers: ProviderInfo[]
  onProvidersChange: (list: ProviderInfo[]) => void
}): JSX.Element {
  const [accounts, setAccounts] = useState<AuthAccountSummary[]>([])
  // One card per vendor that has a flow in the air, keyed by the flow id, so
  // signing in to two vendors at once does not make them fight over one slot.
  const [flows, setFlows] = useState<Record<string, AuthLoginState>>({})
  const [codes, setCodes] = useState<Record<string, string>>({})
  // One row is open at a time: to be renamed, or to confirm its removal.
  const [open, setOpen] = useState<{ id: string; action: 'rename' | 'remove' } | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Expiries are read as "good for 42 min", so the panel keeps its own clock.
  const [now, setNow] = useState(() => Date.now())

  const refresh = async (): Promise<void> => {
    setAccounts(await window.anticode.listAuthAccounts())
    onProvidersChange(await window.anticode.listProviders())
  }

  useEffect(() => {
    void refresh()
    return window.anticode.onAuthLogin((state) => {
      setFlows((current) => ({ ...current, [state.id]: state }))
      if (state.error !== undefined) setError(state.error)
      if (state.done) {
        void refresh()
        // The card has said "Signed in"; let it be read, then clear it.
        setTimeout(() => {
          setFlows((current) => {
            const next = { ...current }
            delete next[state.id]
            return next
          })
        }, 2500)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!accounts.some((row) => row.expiresAt !== undefined && row.expiresAt !== 0)) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [accounts])

  const live = Object.values(flows).filter((state) => !state.done && state.error === undefined)

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setError(null)
    setBusy(id)
    try {
      await action()
      await refresh()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(null)
    }
  }

  async function start(kind: AuthKind): Promise<void> {
    setError(null)
    try {
      const state = await window.anticode.startAuthLogin(kind)
      setFlows((current) => ({ ...current, [state.id]: state }))
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  async function submit(id: string): Promise<void> {
    const code = codes[id] ?? ''
    try {
      await window.anticode.submitAuthCode(id, code)
      setCodes((current) => ({ ...current, [id]: '' }))
    } catch (failure) {
      setError(errorText(failure))
    }
  }

  function dismiss(id: string): void {
    void window.anticode.cancelAuthLogin(id)
    setFlows((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Auth provider</h1>

      <p className="mb-6 max-w-prose text-[12.5px] leading-relaxed text-faint">
        Sign in with an account instead of an API key. Each account is added as a provider
        (<span className="text-dim">auth:codex</span>, <span className="text-dim">auth:claude</span>)
        and can be picked in the composer or added to Rotate usage by name. Tokens are sealed with
        the system keychain and renewed on their own while a session runs.
      </p>

      <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line">
        {VENDORS.map((vendor) => {
          const mine = accounts.filter((row) => row.kind === vendor.kind)
          const running = live.some((state) => state.kind === vendor.kind)
          return (
            <div
              key={vendor.kind}
              data-auth-vendor={vendor.kind}
              className="flex items-center gap-6 border-b border-line-soft px-5 py-4 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13.5px] text-text">{vendor.title}</span>
                  {/* Rendered at every count so the title never shifts when
                      the first account of a vendor appears. */}
                  <span
                    className={`text-[11.5px] tabular-nums text-faint ${mine.length === 0 ? 'invisible' : ''}`}
                  >
                    {mine.length} signed in
                  </span>
                </div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-faint">{vendor.hint}</div>
              </div>
              <button
                type="button"
                disabled={running}
                title={mine.length === 0 ? `Sign in to ${vendor.title}` : `Add another ${vendor.title} account`}
                onClick={() => void start(vendor.kind)}
                className="glass-control w-[104px] shrink-0 rounded-lg border px-3 py-1.5 text-center text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
              >
                {running ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          )
        })}
      </div>

      {Object.values(flows).map((state) => (
        <div
          key={state.id}
          data-auth-flow={state.kind}
          className="glass-surface mb-6 overflow-hidden rounded-xl border border-line px-5 py-4"
        >
          <div className={`text-[13.5px] ${state.error !== undefined ? 'text-del' : 'text-text'}`}>
            {state.status}
          </div>
          {state.url !== undefined && !state.done && (
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block break-all text-[12px] text-dim transition-colors hover:text-brand"
            >
              {state.url}
            </a>
          )}
          {state.needsCode && (
            <div className="mt-3 flex items-center gap-2">
              <input
                value={codes[state.id] ?? ''}
                autoFocus
                onChange={(event) =>
                  setCodes((current) => ({ ...current, [state.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (codes[state.id] ?? '').trim() !== '') void submit(state.id)
                }}
                placeholder="Paste the authorization code"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-text outline-none focus:border-brand"
              />
              <button
                type="button"
                disabled={(codes[state.id] ?? '').trim() === ''}
                onClick={() => void submit(state.id)}
                className="glass-control shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
              >
                Submit
              </button>
            </div>
          )}
          {!state.done && (
            <button
              type="button"
              title="Stop this login"
              onClick={() => dismiss(state.id)}
              className="mt-3 text-[12px] text-dim transition-colors hover:text-brand"
            >
              {state.error !== undefined ? 'Dismiss' : 'Cancel'}
            </button>
          )}
        </div>
      ))}

      {accounts.length === 0 ? (
        <div className="glass-surface rounded-xl border border-line px-5 py-4 text-[12.5px] text-faint">
          No accounts yet.
        </div>
      ) : (
        <div className="glass-surface overflow-hidden rounded-xl border border-line">
          {accounts.map((row) => {
            const renamingThis = open?.id === row.id && open.action === 'rename'
            const removingThis = open?.id === row.id && open.action === 'remove'
            const state = tokenState(row, now)
            const models = providers.find((entry) => entry.id === row.id)?.models ?? []
            // What the id is and what it can run; the token's own state is
            // coloured separately and so is appended rather than joined in.
            const facts = [row.id, models.length > 0 ? `${models.length} models · ${models[0]}` : null].filter(
              (part) => part !== null
            )
            return (
              <div key={row.id} data-auth-account={row.id} className="border-b border-line-soft last:border-b-0">
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13.5px] text-text">{row.label}</span>
                      {/* The one thing that must survive a narrow window: the
                          name can be clipped, the token's state cannot. */}
                      <span className={`shrink-0 text-[11.5px] ${state.tone}`} title={state.title}>
                        {state.text}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
                      {facts.join(' · ')}
                    </div>
                  </div>
                  {removingThis ? (
                    <>
                      <span className="shrink-0 text-[12px] text-dim">Remove?</span>
                      <button
                        type="button"
                        onClick={() => setOpen(null)}
                        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-brand"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        title={`Confirm removing ${row.label}`}
                        onClick={() =>
                          void act(row.id, async () => {
                            onProvidersChange(await window.anticode.removeAuthProvider(row.id))
                            setOpen(null)
                          })
                        }
                        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-del transition-colors hover:bg-raised"
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <>
                      {RENEWABLE[row.kind] && (
                        <button
                          type="button"
                          disabled={busy === row.id || !row.refreshable}
                          title={
                            row.refreshable
                              ? `Renew the token for ${row.label}`
                              : 'This login came without a refresh token'
                          }
                          onClick={() =>
                            void act(row.id, () => window.anticode.refreshAuthProvider(row.id))
                          }
                          // Renew rests at the same weight as Rename beside
                          // it; with nothing to renew it goes darker still,
                          // since faint-on-faint reads as pressable.
                          className="w-[74px] shrink-0 rounded-md px-2 py-1 text-center text-[12px] text-faint transition-colors enabled:hover:bg-raised enabled:hover:text-brand disabled:text-line"
                        >
                          {busy === row.id ? 'Renewing…' : 'Renew'}
                        </button>
                      )}
                      <button
                        type="button"
                        title={`Rename ${row.label}`}
                        onClick={() => {
                          setDraft(row.label)
                          setOpen(renamingThis ? null : { id: row.id, action: 'rename' })
                        }}
                        className={`shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-raised hover:text-brand ${
                          renamingThis ? 'text-text' : 'text-faint'
                        }`}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        title={`Remove ${row.label}`}
                        onClick={() => setOpen({ id: row.id, action: 'remove' })}
                        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:bg-raised hover:text-del"
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
                {removingThis && (
                  <p className="px-5 pb-3 text-[11.5px] leading-relaxed text-faint">
                    The token is forgotten here; the account itself stays with the vendor. Sessions
                    and rotation entries pointing at {row.id} stop working until you sign in again.
                  </p>
                )}
                {renamingThis && (
                  <div className="flex items-center gap-2 border-t border-line-soft px-5 py-3">
                    <input
                      value={draft}
                      autoFocus
                      maxLength={80}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setOpen(null)
                        if (event.key === 'Enter' && draft.trim() !== '') {
                          void act(row.id, async () => {
                            await window.anticode.renameAuthProvider(row.id, draft)
                            setOpen(null)
                          })
                        }
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] text-text outline-none focus:border-brand"
                    />
                    <button
                      type="button"
                      disabled={draft.trim() === ''}
                      onClick={() =>
                        void act(row.id, async () => {
                          await window.anticode.renameAuthProvider(row.id, draft)
                          setOpen(null)
                        })
                      }
                      className="glass-control shrink-0 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(null)}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:text-brand"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {error !== null && <p className="mt-4 text-[12.5px] text-del">{error}</p>}
    </>
  )
}
