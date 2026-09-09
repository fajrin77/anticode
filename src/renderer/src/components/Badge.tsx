import type { JSX } from 'react'
import { SESSION_COLOURS } from '../store/session'

interface BadgeProps {
  /** Text the badge takes its initial from. */
  label: string
  /** Index into SESSION_COLOURS; each session owns one. */
  colour: number
  size?: 'sm' | 'md'
  /** Spins while a run is executing in this session. */
  spinning?: boolean
}

/** Glass gradient chip: two-tone diagonal fill, top light, inner rim. */
export function Badge({ label, colour, size = 'sm', spinning = false }: BadgeProps): JSX.Element {
  const dimension = size === 'sm' ? 'h-4 w-4 text-[10px]' : 'h-5 w-5 text-[11px]'
  const pair = SESSION_COLOURS[colour % SESSION_COLOURS.length] ?? ['#5c5c66', '#3a3a42']
  const [from, to] = pair

  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[5px] font-medium text-white/95 ${dimension} ${
        spinning ? 'badge-spin' : ''
      }`}
      style={{
        background: `linear-gradient(135deg, ${from}f2 0%, ${to}d9 100%)`,
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 1px rgba(0,0,0,0.28), 0 1px 3px rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.14)'
      }}
    >
      {(label[0] ?? '?').toUpperCase()}
    </span>
  )
}
