import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { UsageRecord } from '@shared/ipc'
import { useSessionStore } from '../../store/session'

/** A request this recent still counts as "being drawn from" right now. */
export const LIVE_WINDOW_MS = 20_000
const MAX_NODES = 12

export interface RoutingNode {
  id: string
  label: string
  /** Epoch ms of the newest request seen from this group. */
  lastTs: number
  model: string
  requests: number
  tokens: number
  live: boolean
}

/**
 * Groups the recent request log by the provider that served it. A group is
 * live while its newest request is inside the window; nothing is inferred
 * beyond what the usage log recorded.
 */
export function routingNodes(rows: UsageRecord[], now: number): RoutingNode[] {
  const groups = new Map<string, RoutingNode>()
  for (const row of rows) {
    const id = row.provider
    const found = groups.get(id)
    const tokens = row.inputTokens + row.outputTokens
    if (found === undefined) {
      groups.set(id, { id, label: row.providerLabel || id, lastTs: row.ts, model: row.model, requests: 1, tokens, live: false })
      continue
    }
    found.requests += 1
    found.tokens += tokens
    if (row.ts > found.lastTs) Object.assign(found, { lastTs: row.ts, model: row.model })
  }
  return [...groups.values()]
    .map((node) => ({ ...node, live: now - node.lastTs <= LIVE_WINDOW_MS }))
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, MAX_NODES)
}

const W = 720
const H = 360
const CX = W / 2
const CY = H / 2

function position(index: number, count: number): { x: number; y: number } {
  const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2
  return { x: CX + Math.cos(angle) * 270, y: CY + Math.sin(angle) * 130 }
}

function short(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Live map of where Anticode is drawing models from: the router in the
 * middle, one node per provider group, and the group serving requests right
 * now lit with a moving line. Reads the same request log as the tables below.
 */
export function LiveRouting(): JSX.Element {
  const [rows, setRows] = useState<UsageRecord[]>([])
  const [now, setNow] = useState(() => Date.now())
  const running = useSessionStore((state) => Object.keys(state.activeRuns).length)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.anticode
        .listUsageRecent(150)
        .then((next) => {
          if (cancelled) return
          setRows(next)
          setNow(Date.now())
        })
        .catch(() => undefined)
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const nodes = routingNodes(rows, now)
  const liveCount = nodes.filter((node) => node.live).length

  return (
    <div className="glass-surface mb-5 rounded-xl border border-line p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-[13px] text-text">Live routing</div>
        <div className="text-[11px] text-faint">
          {running > 0 ? `${running} run${running === 1 ? '' : 's'} active` : 'idle'}
          {liveCount > 0 ? ` · ${liveCount} group${liveCount === 1 ? '' : 's'} serving` : ''}
        </div>
      </div>
      {nodes.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-faint">No requests yet. The map fills in as Anticode talks to a provider.</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Providers Anticode is drawing models from">
          <style>{`@keyframes live-flow{to{stroke-dashoffset:-24}}`}</style>
          {nodes.map((node, index) => {
            const { x, y } = position(index, nodes.length)
            return (
              <path
                key={`line-${node.id}`}
                d={`M ${CX} ${CY} Q ${(CX + x) / 2} ${CY} ${x} ${y}`}
                fill="none"
                stroke={node.live ? '#d1fa22' : 'currentColor'}
                strokeOpacity={node.live ? 1 : 0.18}
                strokeWidth={node.live ? 2 : 1}
                strokeDasharray={node.live ? '6 6' : undefined}
                style={node.live ? { animation: 'live-flow 0.8s linear infinite' } : undefined}
              />
            )
          })}
          <g>
            <rect x={CX - 52} y={CY - 18} width={104} height={36} rx={9} fill="#1c2008" stroke="#d1fa22" strokeWidth={1.5} />
            <text x={CX} y={CY + 4} textAnchor="middle" fontSize={13} fill="#d1fa22">Anticode</text>
          </g>
          {nodes.map((node, index) => {
            const { x, y } = position(index, nodes.length)
            return (
              <g key={node.id}>
                <title>{`${node.label} · ${node.model} · ${node.requests} req · ${node.tokens.toLocaleString('en-US')} tokens`}</title>
                <rect
                  x={x - 78}
                  y={y - 20}
                  width={156}
                  height={40}
                  rx={9}
                  fill="rgba(0,0,0,0.25)"
                  stroke={node.live ? '#d1fa22' : 'currentColor'}
                  strokeOpacity={node.live ? 1 : 0.25}
                  strokeWidth={node.live ? 1.8 : 1}
                />
                <text x={x} y={y - 3} textAnchor="middle" fontSize={11.5} fill="currentColor" opacity={node.live ? 1 : 0.7}>
                  {short(node.label, 22)}
                </text>
                <text x={x} y={y + 11} textAnchor="middle" fontSize={9.5} fill="currentColor" opacity={0.5}>
                  {short(node.model, 26)}
                </text>
              </g>
            )
          })}
        </svg>
      )}
      <div className="mt-1 text-[10.5px] text-faint">
        Based on the last 150 logged requests; a group is lit while its latest request is under {LIVE_WINDOW_MS / 1000}s old.
      </div>
    </div>
  )
}
