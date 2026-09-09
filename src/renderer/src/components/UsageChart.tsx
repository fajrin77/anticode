import { useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { UsageEntry } from '../store/session'

/**
 * Two categorical hues validated against the #202020 surface: lightness band,
 * chroma floor, CVD separation (deutan ΔE 15.7), normal-vision separation
 * (ΔE 23.3) and contrast all pass. Do not nudge these by eye.
 */
const INPUT_COLOUR = '#1fa896'
const OUTPUT_COLOUR = '#8f79f0'

function format(value: number): string {
  return value.toLocaleString('id-ID')
}

function Swatch({ colour, label }: { colour: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-dim">
      <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: colour }} />
      {label}
    </span>
  )
}

function Bar({ entry, scale }: { entry: UsageEntry; scale: number }): JSX.Element {
  const [hover, setHover] = useState(false)
  const total = entry.inputTokens + entry.outputTokens
  const width = (total / scale) * 100

  return (
    <div
      className="relative py-2"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="truncate font-mono text-[12px] text-text">{entry.model}</span>
        <span className="shrink-0 text-[11px] text-faint">{entry.provider}</span>
        <span className="ml-auto shrink-0 text-[11.5px] text-dim">{format(total)}</span>
      </div>

      {/* 2px surface gap between segments keeps the boundary readable without a stroke. */}
      <div className="flex h-2.5 gap-0.5" style={{ width: `${Math.max(width, 2)}%` }}>
        <div
          className="rounded-l-sm"
          style={{
            backgroundColor: INPUT_COLOUR,
            flexGrow: Math.max(entry.inputTokens, 1)
          }}
        />
        <div
          className="rounded-r-sm"
          style={{
            backgroundColor: OUTPUT_COLOUR,
            flexGrow: Math.max(entry.outputTokens, 1)
          }}
        />
      </div>

      {hover && (
        <div className="absolute top-0 right-0 z-10 rounded-md border border-line bg-raised px-3 py-2 text-[11.5px] shadow-xl">
          <div className="mb-1 font-mono text-text">{entry.model}</div>
          <div className="flex gap-4 text-dim">
            <span>masuk {format(entry.inputTokens)}</span>
            <span>keluar {format(entry.outputTokens)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function UsageChart(): JSX.Element {
  const usage = useSessionStore((state) => state.usage)

  if (usage.length === 0) {
    return (
      <div className="mb-8 rounded-xl border border-line-soft px-4 py-4">
        <div className="mb-1 text-[13px] text-dim">Pemakaian token</div>
        <p className="text-[12.5px] text-faint">
          Belum ada pemakaian. Angkanya muncul setelah sesi pertama berjalan.
        </p>
      </div>
    )
  }

  const sorted = [...usage].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)
  )
  const scale = sorted[0] ? sorted[0].inputTokens + sorted[0].outputTokens : 1
  const grandTotal = usage.reduce(
    (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
    0
  )

  return (
    <div className="mb-8 rounded-xl border border-line px-4 py-4">
      <div className="mb-3 flex items-baseline gap-3">
        <span className="text-[13px] text-dim">Pemakaian token</span>
        <span className="text-[12px] text-faint">{format(grandTotal)} total</span>
        <span className="ml-auto flex gap-3">
          <Swatch colour={INPUT_COLOUR} label="masuk" />
          <Swatch colour={OUTPUT_COLOUR} label="keluar" />
        </span>
      </div>

      <div className="divide-y divide-line-soft">
        {sorted.map((entry) => (
          <Bar key={`${entry.provider}/${entry.model}`} entry={entry} scale={scale} />
        ))}
      </div>
    </div>
  )
}
