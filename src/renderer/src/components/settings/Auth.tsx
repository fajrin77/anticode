import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { ComposerVisibility, ComposerGroupVisibility } from './ComposerVisibility'
import { Toggle } from './controls'
import { DIRECT_AUTH_PROVIDERS, DIRECT_AUTH_REFRESH, isDirectAuthKind, type DirectAuthKind } from '@shared/directAuthProviders'
import { Connectors } from './Connectors'
import { AccountGroup } from './AccountGroup'
import type { AuthAccountSummary, AuthKind, AuthLoginState, ProviderInfo, SessionStatus, SubscriptionQuota } from '@shared/ipc'

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
  { kind: 'antigravity', title: 'Antigravity', hint: 'Google browser authorization. Uses your activated Antigravity account directly; Gemini models only.' },
  { kind: 'claude', title: 'Claude Code', hint: 'Uses the official Claude Code engine with your Claude subscription. Extra usage must be off; no 9Router required.' },
  { kind: 'clinepass', title: 'ClinePass', hint: 'Subscription ClinePass dengan akun Cline.' },
  { kind: 'cline', title: 'Cline Free', hint: 'Sign in to your Cline account; the provider talks to api.cline.bot.' },
  { kind: 'opencode-go', title: 'OpenCode Go', hint: 'Login di Console, lalu salin key dari workspace dengan paket Go / Go Plus aktif dan tempel di sini. Membuka dashboard belum menghubungkan akun. Matikan Extra usage agar tetap dalam batas paket.' },
  { kind: 'minimax-plan', title: 'MiniMax M Plan', hint: 'Login ke MiniMax → Plan Details, salin Subscription Key (sk-cp) M Plan / Token Plan, lalu tempel di sini. MiniMax tidak menyediakan login browser untuk app lain. Key API pay-as-you-go tidak diterima.' },
  {
    kind: 'codebuddy',
    title: 'CodeBuddy',
    hint: 'Sign in at codebuddy.ai; the account speaks OpenAI’s wire format.'
  },
  { kind: 'kilo', title: 'Kilo Free', hint: 'Browser device login; free model routes only. Credits and subscriptions are not assumed.' },
  { kind: 'openrouter', title: 'OpenRouter Free', hint: 'Login dan setujui akses di browser; Anticode menerima kodenya otomatis lewat localhost. Hanya rute model gratis yang dipakai.' },
  { kind: 'copilot', title: 'GitHub Copilot', hint: 'Authorize with a GitHub device code. Uses your Copilot account directly.' },
  { kind: 'cursor', title: 'Cursor', hint: 'Browser authorization. Requires the official Cursor Agent CLI. Text/tool adapter; native CLI tools are denied.' },
  ...Object.entries(DIRECT_AUTH_PROVIDERS).map(([kind, config]) => ({ kind: kind as DirectAuthKind, title: config.label, hint: config.hint }))
]

/** Vendors kept in code but not offered for new sign-ins. */
const HIDDEN = new Set<AuthKind>(['opencode-go', 'minimax-plan'])

/** Manual renewal is also available for providers with refresh grants. */
const RENEWABLE: Record<AuthKind, boolean> = {
  ...DIRECT_AUTH_REFRESH,
  'minimax-plan': false,
  kilo: false,
  openrouter: false,
  // A gateway key is pasted once and never renews.
  vercel: false,
  copilot: false,
  cursor: false,
  antigravity: true,
  codex: true,
  claude: true,
  cline: true,
  clinepass: true,
  'opencode-go': false,
  codebuddy: true
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
  status,
  onProvidersChange
}: {
  providers: ProviderInfo[]
  status: SessionStatus | null
  onProvidersChange: (list: ProviderInfo[]) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState<Partial<Record<AuthKind, boolean>>>({})
  const [routingBusy, setRoutingBusy] = useState(false)
  const [quotas, setQuotas] = useState<SubscriptionQuota[] | null>(null)
  const [quotaBusy, setQuotaBusy] = useState(false)
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
    setExpanded(current => ({ ...current, [kind]: true }))
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

  async function toggleRouting(): Promise<void> {
    setRoutingBusy(true)
    setError(null)
    try { await window.anticode.setSubscriptionRouting(!(status?.subscriptionOnly && status.rotationEnabled)) }
    catch (failure) { setError(errorText(failure)) }
    finally { setRoutingBusy(false) }
  }


  async function refreshQuotas(): Promise<void> {
    setQuotaBusy(true)
    try { setQuotas(await window.anticode.getSubscriptionQuotas()) }
    catch (failure) { setError(errorText(failure)) }
    finally { setQuotaBusy(false) }
  }

  function renderFlow(state: AuthLoginState): JSX.Element {
    return (
        <div
          key={state.id}
          data-auth-flow={state.kind}
          className="mx-3 my-3 rounded-lg border border-line px-4 py-3"
        >
          <div className={`text-[13.5px] ${state.error !== undefined ? 'text-del' : 'text-text'}`}>
            {state.status}
          </div>
          {accounts.some((row) => row.kind === state.kind) && !state.done && !state.error && (
            <p className="mt-1 text-[12px] text-faint">Choose another account in your browser.</p>
          )}
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
          {state.kind === 'copilot' && !state.done && !state.error && <p className="mt-2 text-[12px] text-faint">The device code is shown above, not sent by email. Enter it on GitHub, click Continue, then approve access. If GitHub separately requests account verification or 2FA, complete that on GitHub.</p>}
          {state.kind === 'opencode-go' && state.needsCode && <p className="mt-2 text-[12px] text-faint">Turn off Extra usage in OpenCode Console to stay within plan limits.</p>}
          {state.needsCode && (
            <div className="mt-3 flex items-center gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={state.kind === 'claude' ? 'Claude code#state or callback URL' : state.kind === 'minimax-plan' ? 'MiniMax Token Plan sk-cp key' : state.kind === 'openrouter' ? 'OpenRouter authorization code' : state.kind === 'vercel' ? 'Vercel AI Gateway API key' : 'Authorization code or key'}
                value={codes[state.id] ?? ''}
                autoFocus
                onChange={(event) =>
                  setCodes((current) => ({ ...current, [state.id]: event.target.value }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (codes[state.id] ?? '').trim() !== '') void submit(state.id)
                }}
                placeholder={state.kind === 'opencode-go' ? 'OpenCode Go plan key' : state.kind === 'minimax-plan' ? 'MiniMax Token Plan sk-cp key' : state.kind === 'claude' ? 'Paste the complete code#state or callback URL' : 'Paste the authorization code'}
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
              className="mt-3 block text-[12px] text-dim transition-colors hover:text-brand"
            >
              {state.error !== undefined ? 'Dismiss' : 'Cancel'}
            </button>
          )}
        </div>
    )
  }

  function renderAccount(row: AuthAccountSummary): JSX.Element {
            const renamingThis = open?.id === row.id && open.action === 'rename'
            const removingThis = open?.id === row.id && open.action === 'remove'
            const state = tokenState(row, now)
            const provider = providers.find((entry) => entry.id === row.id)
            const models = provider?.models ?? []
            // What the id is and what it can run; the token's own state is
            // coloured separately and so is appended rather than joined in.
            const facts = [ models.length > 0 ? `${models.length} models · ${models[0]}` : null].filter(
              (part) => part !== null
            )
            return (
              <div key={row.id} data-auth-account={row.id} className="border-b border-line-soft last:border-b-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                  <div className="min-w-[180px] flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span title={row.label} className="min-w-0 break-all text-[13px] text-text">{row.label.startsWith((VENDORS.find(vendor => vendor.kind === row.kind)?.title ?? '') + ' · ') ? row.label.split(' · ').slice(1).join(' · ') : row.label}</span>
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
                  {provider && (
                    <ComposerVisibility provider={provider} onChange={onProvidersChange} />
                  )}
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
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">Auth provider</h1>

      <div className="glass-surface mb-6 overflow-hidden rounded-xl border border-line" data-subscription-routing>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div>
            <h2 className="text-[13.5px] text-text">Subscription routing</h2>
          </div>
          <Toggle on={status?.subscriptionOnly === true && status.rotationEnabled}
            disabled={routingBusy} label="Subscription routing"
            title="Automatically switch between connected plans. Provider extra usage settings still apply."
            onChange={() => void toggleRouting()} />
        </div>
        <div className="border-t border-line-soft px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-[12.5px] text-dim">Subscription quotas</span>
            <button type="button" disabled={quotaBusy} onClick={() => void refreshQuotas()}
              aria-label={accounts.some(account => account.kind === 'claude') ? 'Refresh subscription quotas' : 'Refresh ChatGPT quota'}
              className="text-[12px] text-faint hover:text-brand disabled:text-faint">
              {quotaBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {quotas?.length === 0 && <p className="mt-2 text-[12px] text-faint">No connected account.</p>}
          {quotas?.map((quota) => (
            <div key={quota.provider} className="mt-3 text-[12px] text-faint" title={`Checked ${absolute(quota.checkedAt)}`}>
              <span className="text-dim">{quota.label}{quota.plan ? ` · ${quota.plan}` : ''}</span>
              {quota.extraUsageEnabled !== undefined && <p>{quota.extraUsageEnabled === false ? 'Extra usage off · third-party billing entitlement unverified' : 'Extra usage enabled or unknown · inference blocked'}</p>}
              {quota.error ? <p>{quota.error}</p> : quota.windows.map((window) => (
                <p key={window.label}>{window.label}: {window.usedPercent === null ? 'unknown usage' : `${window.usedPercent}% used`}
                  {window.resetAt !== null ? ` · resets ${absolute(window.resetAt)}` : ''}</p>
              ))}
            </div>
          ))}
        </div>
      </div>

      <Connectors />
      <p className="text-[12px] text-faint">Direct account connections. API-key routes may incur charges and are not subscription OAuth. Scroll to see all providers.</p>
      <div data-auth-providers tabIndex={0} role="region" aria-label="Auth providers — scroll for all providers" className="glass-surface max-h-[660px] overflow-y-auto overscroll-contain rounded-xl border border-line">
        {VENDORS.map(vendor => {
          const mine = accounts.filter(row => row.kind === vendor.kind)
          const running = live.some(state => state.kind === vendor.kind)
          // OpenCode Go stays supported but off the list; an account already
          // connected still shows so it can be renamed or removed.
          if (HIDDEN.has(vendor.kind) && mine.length === 0 && !running) return null
          const keyConnection = isDirectAuthKind(vendor.kind) || vendor.kind === 'opencode-go' || vendor.kind === 'minimax-plan'
          return (
            <div key={vendor.kind} data-auth-vendor={vendor.kind} className="border-b border-line-soft last:border-b-0">
              <AccountGroup id={`auth-${vendor.kind}`} title={vendor.title} count={mine.length}
                expanded={expanded[vendor.kind] === true}
                onToggle={() => setExpanded(current => ({ ...current, [vendor.kind]: !current[vendor.kind] }))}
                action={<><ComposerGroupVisibility members={providers.filter(p => p.authKind === vendor.kind)} label={vendor.title} onChange={onProvidersChange} /><button type="button" disabled={running}
                  title={mine.length ? `Add another ${vendor.title} account` : `Connect ${vendor.title}`}
                  onClick={() => void start(vendor.kind)}
                  className="glass-control w-[112px] shrink-0 rounded-lg border px-3 py-1.5 text-center text-[12px] text-text enabled:hover:text-brand disabled:text-faint">
                  {running ? 'Connecting…' : mine.length ? 'Add account' : keyConnection ? 'Connect key' : 'Sign in'}
                </button></>}>
                {Object.values(flows).filter(state => state.kind === vendor.kind).map(renderFlow)}
                {mine.map(renderAccount)}
              </AccountGroup>
            </div>
          )
        })}
      </div>

      {error !== null && <p className="mt-4 text-[12.5px] text-del">{error}</p>}
    </>
  )
}
