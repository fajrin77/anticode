import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AuthKind, SubscriptionQuota } from '@shared/ipc'
import { quotaResetLabel, quotaWindowLabel } from './subscriptionUsageFormat'

/** Which quota groups the user left open; kept across leaving and reopening Settings. */
let openState: Record<string, boolean> = {}

const LABELS: Record<AuthKind, string> = { claude: 'Claude Code', codex: 'ChatGPT', cline: 'Cline Free', clinepass: 'ClinePass', codebuddy: 'CodeBuddy', 'opencode-go': 'OpenCode Go', 'minimax-plan': 'MiniMax Token Plan', kilo: 'Kilo', openrouter: 'OpenRouter', vercel: 'Vercel AI Gateway' }

export function SubscriptionUsage(): JSX.Element {
  const [quotas, setQuotas] = useState<SubscriptionQuota[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  // A group starts closed, unless it was open before (it survives remounts).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(openState)
  const mounted = useRef(false)
  const loading = useRef(false)
  const refresh = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    setBusy(true)
    try {
      const result = await window.anticode.getSubscriptionQuotas()
      if (mounted.current) { setQuotas(result); setError(null); setNow(Date.now()) }
    } catch {
      if (mounted.current) setError('Belum dapat memperbarui kuota. Data terakhir tetap ditampilkan.')
    } finally { loading.current = false; if (mounted.current) setBusy(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => { setNow(Date.now()); if (!document.hidden) void refresh() }, 60_000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [refresh])

  const groups = new Map<string, { label: string; accounts: SubscriptionQuota[] }>()
  for (const quota of quotas ?? []) {
    const id = quota.authKind ?? quota.provider
    if (!groups.has(id)) groups.set(id, { label: quota.authKind ? LABELS[quota.authKind] : quota.label, accounts: [] })
    groups.get(id)!.accounts.push(quota)
  }
  return <section className="glass-surface mb-5 overflow-hidden rounded-xl border border-line" aria-label="Batas penggunaan paket" data-subscription-usage>
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <h2 className="text-[13.5px] text-text">Batas penggunaan paket</h2>
      <button type="button" aria-label="Perbarui kuota subscription" disabled={busy} onClick={() => void refresh()} className="shrink-0 rounded-md px-2 py-1 text-[12px] text-dim hover:text-brand disabled:text-faint">{busy ? 'Memperbarui…' : 'Perbarui'}</button>
    </div>
    {error && <p role="status" className="px-4 pb-3 text-[12px] text-amber-400">{error}</p>}
    {quotas === null && !error && <p className="px-4 pb-4 text-[12px] text-faint">Membaca kuota paket…</p>}
    {quotas?.length === 0 && <p className="px-4 pb-4 text-[12px] text-faint">Belum ada akun subscription terhubung. Tambahkan akun melalui Auth provider.</p>}
    {[...groups].sort(([, a], [, b]) => Number(b.accounts.some(q => q.status !== 'unsupported')) - Number(a.accounts.some(q => q.status !== 'unsupported'))).map(([id, group]) => <details key={id} open={openGroups[id] === true} onToggle={(event) => { const isOpen = event.currentTarget.open; openState = { ...openState, [id]: isOpen }; setOpenGroups(state => state[id] === isOpen ? state : { ...state, [id]: isOpen }) }} className="border-t border-line-soft" data-quota-group={id}>
      <summary className="cursor-pointer px-4 py-3 text-[13px] text-text">{group.label}<span className="ml-2 text-[12px] text-faint">{group.accounts.length} akun</span></summary>
      <div className="space-y-3 px-4 pb-4">{group.accounts.map(quota => <div key={quota.provider} className="rounded-lg border border-line-soft bg-surface/30 px-4 py-3" data-quota-account={quota.provider}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="min-w-0 break-words text-[12.5px] text-dim">{quota.account ?? quota.label}{quota.plan && <span className="ml-2 capitalize text-faint">· {quota.plan}</span>}</h3>
          {quota.status !== 'unsupported' && <time dateTime={new Date(quota.checkedAt).toISOString()} title={new Date(quota.checkedAt).toLocaleString()} className="text-[11px] text-faint">{quota.status === 'stale' || error ? 'Data terakhir' : 'Diperbarui'} {new Date(quota.checkedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}</time>}
        </div>
        {quota.error && <p role="status" className={`mt-2 text-[12px] ${quota.status === 'unsupported' ? 'text-faint' : 'text-amber-400'}`}>{quota.error}{quota.status === 'stale' ? ' Menampilkan data terakhir.' : ''}</p>}
        {quota.windows.map((window, index) => {
          const label = quotaWindowLabel(window.label)
          const used = window.usedPercent === null || !Number.isFinite(window.usedPercent) ? null : Math.max(0, Math.min(100, window.usedPercent))
          return <div key={`${window.label}-${index}`} className="mt-3">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12.5px]">
              <span className="text-text">{label}</span><span className="ml-auto text-right text-faint" title={window.resetAt === null ? undefined : new Date(window.resetAt).toLocaleString()}>{quotaResetLabel(window.resetAt, now)}<span className="ml-3 tabular-nums">{used === null ? '—' : `${Math.round(used)}%`}</span></span>
            </div>
            <div role="progressbar" aria-label={`${quota.account ?? quota.label} · ${label}`} aria-valuemin={0} aria-valuemax={100} {...(used === null ? { 'aria-valuetext': 'Persentase pemakaian belum tersedia' } : { 'aria-valuenow': used, 'aria-valuetext': `${Math.round(used)}% terpakai${quota.status === 'stale' || error ? ' · data terakhir' : ''}` })} className="h-1.5 overflow-hidden rounded-full bg-white/10">
              {used !== null && <div className={`h-full rounded-full ${used >= 95 ? 'bg-red-400' : used >= 80 ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${used}%` }} />}
            </div>
          </div>
        })}
      </div>)}</div>
    </details>)}
  </section>
}
