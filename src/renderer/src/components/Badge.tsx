import type { JSX } from 'react'
import { badgeColour } from '../store/session'

interface BadgeProps {
  name: string
  size?: 'sm' | 'md'
}

export function Badge({ name, size = 'sm' }: BadgeProps): JSX.Element {
  const dimension = size === 'sm' ? 'h-4 w-4 text-[10px]' : 'h-5 w-5 text-[11px]'
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded font-medium text-white/90 ${dimension}`}
      style={{ backgroundColor: badgeColour(name) }}
    >
      {(name[0] ?? '?').toUpperCase()}
    </span>
  )
}
