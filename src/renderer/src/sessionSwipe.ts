/** Wheel events include trackpad momentum; a quiet interval ends one gesture. */
export const SWIPE_IDLE_MS = 90
/** A deliberate new flick may begin before the previous momentum fully dies. */
export const SWIPE_REARM_MS = 45
export const SWIPE_REARM_DELTA = 6
/** Momentum only decays; an event this much stronger than the tail's peak is
 * a new flick, recognised immediately instead of after the residue dies. */
export const SWIPE_TAIL_ESCAPE_RATIO = 2
/** Deliberate horizontal travel before the neighbour is committed. */
export const SWIPE_THRESHOLD = 32
/** The swap itself: a short fade-in, never a sideways slide. */
export const SWIPE_COMMIT_MS = 140
/** A wheel step at or below this speed means the fingers have let go. */
export const SWIPE_SETTLE_DELTA = 6

export function swipeDelta(x: number, y: number, mode: number): number {
  if (Math.abs(x) <= Math.abs(y) * 1.4) return 0
  return x * (mode === 1 ? 16 : mode === 2 ? 240 : 1)
}

export function swipeTarget(ids: string[], active: string | null, distance: number): string | null {
  const index = ids.indexOf(active ?? '')
  if (index < 0 || Math.abs(distance) < SWIPE_THRESHOLD) return null
  return ids[index + (distance > 0 ? 1 : -1)] ?? null
}

/** Distinguishes a fresh flick from the small, decaying tail of the last one. */
export function canRearmSwipe(
  gapMs: number,
  delta: number,
  previousDirection: number,
  tailPeak = 0
): boolean {
  if (delta === 0 || Math.abs(delta) < SWIPE_REARM_DELTA) return false
  if (previousDirection !== 0 && Math.sign(delta) !== previousDirection) return true
  if (gapMs > SWIPE_REARM_MS) return true
  // A flick in the same direction as the dying momentum used to wait for the
  // residue to stop — up to a second of dead swipes. Momentum only weakens,
  // so an event clearly out-punching everything the tail has produced is a
  // deliberate flick, not residue.
  return Math.abs(delta) >= tailPeak * SWIPE_TAIL_ESCAPE_RATIO + SWIPE_REARM_DELTA
}
