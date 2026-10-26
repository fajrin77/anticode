import { AccessReport } from './AccessReport'
import { SubscriptionUsage } from './SubscriptionUsage'
import { LiveRouting } from './LiveRouting'
import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UsageRecord, UsageSummary } from '@shared/ipc'
import { formatUsd } from '../../money'
import { usageModelTotals } from './usageModelTotals'

type RangeId = 'today' | 'month' | '24h' | '7d' | '30d' | '60d' | 'all'

const RANGES: { id: RangeId; label: string; ms: number | null }[] = [
  { id: 'today', label: 'Today', ms: -1 },
  { id: 'month', label: 'This month', ms: -1 },
  { id: '24h', label: '24h', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7D', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '30d', label: '30D', ms: 30 * 24 * 60 * 60 * 1000 },
  { id: '60d', label: '60D', ms: 60 * 24 * 60 * 60 * 1000 },
  { id: 'all', label: 'All', ms: null }
]

function rangeMs(id: RangeId): number | null {
  if (id === 'today' || id === 'month') {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    if (id === 'month') start.setDate(1)
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

/**
 * A long total (nine digits and up) would run past the card and clip on its
 * right edge, so the type steps down instead of the number being cut off.
 */
function valueSize(value: string): string {
  if (value.length > 13) return 'text-[12px]'
  if (value.length > 11) return 'text-[13px]'
  if (value.length > 8) return 'text-[15px]'
  return 'text-[17px]'
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }): JSX.Element {
  return (
    <div className="glass-surface flex min-w-0 flex-col items-center rounded-xl border border-line px-2 py-3 text-center">
      <div className="w-full truncate text-[11px] tracking-wide text-faint uppercase">{label}</div>
      <div title={value} className={`mt-1 w-full tabular-nums ${valueSize(value)} ${accent ?? 'text-text'}`}>{value}</div>
      {sub !== undefined && <div title={sub} className="mt-0.5 w-full truncate text-[10.5px] text-faint">{sub}</div>}
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
/** Survives leaving Settings and coming back; a fresh launch starts on Today. */
let lastRange: RangeId = 'today'

export function Usage(): JSX.Element {
  const [range, setRangeState] = useState<RangeId>(lastRange)
  const setRange = (next: RangeId): void => {
    lastRange = next
    setSelectedDay(null)
    setRangeState(next)
  }
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
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

      <LiveRouting />

      <SubscriptionUsage />

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
          <div className="grid grid-cols-5 gap-2">
            <Card label="Total requests" value={formatNumber(summary.requests)} />
            <Card label="Total input" value={formatNumber(summary.inputTokens)} />
            <Card label="Cached tokens" value={formatNumber(summary.cachedTokens)} sub="Served from cache" />
            <Card label="Output tokens" value={formatNumber(summary.outputTokens)} />
            <Card
              label="Est. cost"
              value={summary.requests > 0 && summary.costPartial && summary.costUsd === 0 ? '—' : `~${formatUsd(summary.costUsd)}`}
              sub={summary.costPartial ? 'Partial — includes unpriced or subscription usage' : 'Estimated, not actual billing'}
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
                <div>
                  <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[11.5px] text-dim">
                    <span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-sky-400" />Input non-cache</span>
                    <span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-violet-400" />Cache (bagian input)</span>
                    <span><i className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-amber-400" />Output</span>
                  </div>
                  <div className="flex h-40 items-end gap-2 overflow-x-auto" aria-label="Tokens per day">
                    {[...summary.byDay].sort((a, b) => a.day.localeCompare(b.day)).map(day => {
                      const total = day.inputTokens + day.outputTokens
                      const cached = Math.min(day.inputTokens, Math.max(0, day.cachedTokens ?? 0))
                      const input = Math.max(0, day.inputTokens - cached)
                      const height = maxDay ? Math.max(2, total / maxDay * 100) : 0
                      return <button key={day.day} type="button" aria-pressed={selectedDay === day.day}
                        onClick={() => setSelectedDay(current => current === day.day ? null : day.day)}
                        className="group flex h-full min-w-[44px] max-w-[96px] flex-1 flex-col items-center justify-end gap-1 rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-brand"
                        title={`${day.day}: input non-cache ${formatNumber(input)}, cache ${formatNumber(cached)}, output ${formatNumber(day.outputTokens)}`}>
                        <span className="text-[10px] tabular-nums text-dim">{Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(total)}</span>
                        <div className="flex h-28 w-full items-end justify-center">
                          <div className="flex w-7 flex-col-reverse overflow-hidden rounded-sm group-hover:opacity-80" style={{ height: `${height}%` }}>
                            <div className="bg-sky-400" style={{ height: `${total ? input / total * 100 : 0}%` }} />
                            <div className="bg-violet-400" style={{ height: `${total ? cached / total * 100 : 0}%` }} />
                            <div className="bg-amber-400" style={{ height: `${total ? day.outputTokens / total * 100 : 0}%` }} />
                          </div>
                        </div>
                        <span className="text-[10px] tabular-nums text-faint">{day.day.slice(5)}</span>
                      </button>
                    })}
                  </div>
                  {(() => {
                    const selected = summary.byDay.find(day => day.day === selectedDay)
                    const day = selected ?? { ...summary, models: summary.byModel }
                    return <div className="mt-4 border-t border-line-soft pt-3" data-day-breakdown>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12px] text-text">{selected?.day ?? `Total ${RANGES.find(item => item.id === range)?.label}`} · {formatNumber(day.requests)} requests</p>
                        {selected && <button type="button" className="text-[12px] text-brand" onClick={() => setSelectedDay(null)}>Show range total</button>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] tabular-nums">
                        <span className="text-sky-400">Input non-cache: {formatNumber(Math.max(0, day.inputTokens - day.cachedTokens))}</span>
                        <span className="text-violet-400">Cache: {formatNumber(day.cachedTokens)}</span>
                        <span className="text-amber-400">Output: {formatNumber(day.outputTokens)}</span>
                      </div>
                      <div className="mt-2 overflow-x-auto">
                        <div data-usage-model-grid className="grid grid-cols-[minmax(120px,1fr)_max-content_max-content_max-content] items-baseline gap-x-5 gap-y-2 text-[11.5px]">
                          {usageModelTotals(day.models ?? []).map(model => <div key={model.model} className="contents">
                            <span className="break-all text-dim">{model.model}</span>
                            <span data-usage-column="input" className="whitespace-nowrap tabular-nums text-faint">Input {formatNumber(model.inputTokens)}</span>
                            <span data-usage-column="cache" className="whitespace-nowrap tabular-nums text-faint">Cache {formatNumber(model.cachedTokens)}</span>
                            <span data-usage-column="output" className="whitespace-nowrap tabular-nums text-faint">Output {formatNumber(model.outputTokens)}</span>
                          </div>)}
                        </div>
                      </div>
                    </div>
                  })()}
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

          <AccessReport />

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
