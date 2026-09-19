import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UsageRecord, UsageSummary } from '@shared/ipc'
import { formatUsd } from '../../money'

type RangeId = 'today' | '24h' | '7d' | '30d' | '60d' | 'all'

const RANGES: { id: RangeId; label: string; ms: number | null }[] = [
  { id: 'today', label: 'Today', ms: -1 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '60d', label: '60D', ms: 60 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All', ms: null }
]

function rangeMs(id: RangeId): number | null {
  if (id === 'today') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return Date.now() - start.getTime()
  }
  return RANGES.find((range) => range.id === id)?.ms ?? null
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function errorText(failure: unknown): string {
  return String((failure as Error)?.message ?? failure).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  )
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }): JSX.Element {
  return (
    <div className="glass-surface rounded-xl border border-line p-4">
      <div className="text-[11px] tracking-wide text-faint uppercase">{label}</div>
      <div className={`mt-1 text-[22px] tabular-nums ${accent ?? 'text-text'}`}>{value}</div>
      {sub !== undefined && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  )
}

/**
 * Token usage and cost analytics, the 9Router-style page for anticode.
 * Every number comes from the persistent per-request log in the main
 * process — real provider-reported tokens with priced cost — never from
 * the chars/4 replay estimate. Ranges filter by request timestamp, so
 * Today / 7D / 30D / All always agree with the rows below them.
 */
export function Usage(): JSX.Element {
  const [range, setRange] = useState<RangeId>('7d')
  const [tab, setTab] = useState<'overview' | 'details'>('overview')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [recent, setRecent] = useState<UsageRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    void window.anticode
      .getUsageSummary(rangeMs(range))
      .then((result) => {
        if (!cancelled) setSummary(result)
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(errorText(failure))
      })
    void window.anticode
      .listUsageRecent(50)
      .then((rows) => {
        if (!cancelled) setRecent(rows)
      })
      .catch(() => undefined)
    // While the page is open a run elsewhere keeps appending rows; poll
    // lightly so the cards track it without any event plumbing.
    const timer = window.setInterval(() => {
      void window.anticode
        .getUsageSummary(rangeMs(range))
        .then((result) => {
          if (!cancelled) setSummary(result)
        })
        .catch(() => undefined)
    }, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [range])

  function clear(): void {
    setClearing(true)
    void window.anticode
      .clearUsage()
      .then(() => window.anticode.getUsageSummary(rangeMs(range)))
      .then((result) => {
        setSummary(result)
        return window.anticode.listUsageRecent(50)
      })
      .then(setRecent)
      .catch((failure: unknown) => setError(errorText(failure)))
      .finally(() => {
        setClearing(false)
        setConfirmClear(false)
      })
  }

  const maxDay = summary?.byDay.reduce((max, day) => Math.max(max, day.inputTokens + day.outputTokens), 0) ?? 0

  return (
    <>
      <h1 className="text-[19px] text-text">Usage &amp; Analytics</h1>
      <p className="mt-1 mb-5 text-[12.5px] text-faint">
        Real API usage per model and day, from provider-reported tokens. Estimated cost follows Settings → Pricing.
      </p>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg border border-line bg-raised p-1" role="tablist" aria-label="Usage view">
          {(['overview', 'details'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-[12.5px] capitalize transition-colors ${
                tab === id ? 'glass-control border text-text' : 'border border-transparent text-dim hover:text-brand'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg border border-line bg-raised p-1" aria-label="Time range">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setRange(item.id)}
              aria-pressed={range === item.id}
              className={`rounded-md px-2.5 py-1 text-[12.5px] tabular-nums transition-colors ${
                range === item.id ? 'glass-control border text-text' : 'border border-transparent text-dim hover:text-brand'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error !== null && <div className="mb-4 text-[12.5px] text-del">{error}</div>}

      {summary === null ? (
        <div className="text-[13px] text-faint">Loading usage…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Card label="Total requests" value={formatNumber(summary.requests)} />
            <Card label="Total input" value={formatNumber(summary.inputTokens)} />
            <Card label="Cached tokens" value={formatNumber(summary.cachedTokens)} sub="Served from cache" />
            <Card label="Output tokens" value={formatNumber(summary.outputTokens)} />
            <Card
              label="Est. cost"
              value={`~${formatUsd(summary.costUsd)}`}
              sub={summary.costPartial ? 'Partial — a model has no price' : 'Estimated, not actual billing'}
            />
          </div>

          {tab === 'overview' && (
            <div className="glass-surface mt-4 rounded-xl border border-line p-4">
              <div className="mb-3 text-[12.5px] text-dim">Tokens per day</div>
              {summary.byDay.length === 0 ? (
                <div className="py-6 text-center text-[12.5px] text-faint">
                  No requests in this range yet. Send a prompt and it shows up here.
                </div>
              ) : (
                <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Tokens per day">
                  {summary.byDay.map((day) => {
                    const total = day.inputTokens + day.outputTokens
                    const height = maxDay === 0 ? 0 : Math.max(3, Math.round((total / maxDay) * 100))
                    return (
                      <div key={day.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1" title={`${day.day} · ${formatNumber(total)} tokens · ${formatNumber(day.requests)} requests`}>
                        <div className="flex h-24 w-full items-end">
                          <div className="w-full rounded-sm bg-brand/80 transition-colors group-hover:bg-brand" style={{ height: `${height}%` }} />
                        </div>
                        <div className="truncate text-[10px] tabular-nums text-faint">{day.day.slice(5)}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'details' && (
            <div className="glass-surface mt-4 overflow-hidden rounded-xl border border-line">
              <div className="border-b border-line-soft px-4 py-2.5 text-[12.5px] text-dim">By model</div>
              {summary.byModel.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12.5px] text-faint">No requests in this range yet.</div>
              ) : (
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-left text-faint">
                      <th className="px-4 py-2 font-normal">Model</th>
                      <th className="px-2 py-2 text-right font-normal">Req</th>
                      <th className="px-2 py-2 text-right font-normal">In</th>
                      <th className="px-2 py-2 text-right font-normal">Out</th>
                      <th className="px-4 py-2 text-right font-normal">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byModel.map((row) => (
                      <tr key={`${row.provider}\n${row.model}`} className="border-t border-line-soft">
                        <td className="max-w-44 truncate px-4 py-2 text-text" title={`${row.provider} · ${row.model}`}>
                          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                          {row.model}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-dim">{formatNumber(row.requests)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-dim">{formatNumber(row.inputTokens)}</td>
                        <td className="px-2 py-2 text-right tabular-nums text-dim">{formatNumber(row.outputTokens)}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-text">
                          {row.costPartial ? '≥ ' : ''}{formatUsd(row.costUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="glass-surface mt-4 overflow-hidden rounded-xl border border-line">
            <div className="border-b border-line-soft px-4 py-2.5 text-[12.5px] text-dim">Recent requests</div>
            {recent.length === 0 ? (
              <div className="px-4 py-6 text-center text-[12.5px] text-faint">Nothing recorded yet.</div>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-faint">
                    <th className="px-4 py-2 font-normal">Model</th>
                    <th className="hidden px-2 py-2 font-normal sm:table-cell">Time</th>
                    <th className="px-2 py-2 text-right font-normal">In / Out</th>
                    <th className="px-4 py-2 text-right font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((row, index) => (
                    <tr key={`${row.ts}-${row.runId}-${index}`} className="border-t border-line-soft">
                      <td className="max-w-40 truncate px-4 py-2 text-text" title={`${row.providerLabel} · ${row.model}`}>
                        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                        {row.model}
                        {row.estimated && <span className="ml-1.5 text-[10.5px] text-faint">est</span>}
                        {row.subagent && <span className="ml-1.5 text-[10.5px] text-faint">side</span>}
                      </td>
                      <td className="hidden px-2 py-2 whitespace-nowrap text-faint sm:table-cell">{formatTime(row.ts)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <span className="text-text">{formatNumber(row.inputTokens)}↑</span>
                        <span className="text-dim"> {formatNumber(row.outputTokens)}↓</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text">
                        {row.costUsd === null ? '—' : formatUsd(row.costUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            {confirmClear ? (
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="text-dim">Clear all recorded usage?</span>
                <button
                  type="button"
                  onClick={clear}
                  disabled={clearing}
                  className="rounded-md border border-del/40 px-2.5 py-1 text-del transition-colors hover:text-del disabled:opacity-50"
                >
                  {clearing ? 'Clearing…' : 'Yes, clear'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="rounded-md border border-transparent px-2.5 py-1 text-dim transition-colors hover:text-brand"
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="rounded-md border border-transparent px-2.5 py-1 text-[12.5px] text-faint transition-colors hover:text-del"
              >
                Clear usage history…
              </button>
            )}
          </div>
        </>
      )}
    </>
  )
}
