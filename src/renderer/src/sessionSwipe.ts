/** Wheel events include trackpad momentum; a quiet interval ends one gesture. */
export const SWIPE_IDLE_MS = 220
export const SWIPE_THRESHOLD = 110

export function swipeDelta(x: number, y: number, mode: number): number {
  if (Math.abs(x) <= Math.abs(y) * 1.4) return 0
  return x * (mode === 1 ? 16 : mode === 2 ? 240 : 1)
}

export function swipeTarget(ids: string[], active: string | null, distance: number): string | null {
  const index = ids.indexOf(active ?? '')
  if (index < 0 || Math.abs(distance) < SWIPE_THRESHOLD) return null
  return ids[index + (distance > 0 ? 1 : -1)] ?? null
}
