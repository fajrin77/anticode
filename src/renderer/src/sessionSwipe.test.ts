import { describe, expect, it } from 'vitest'
import {
  SWIPE_COMMIT_MS,
  SWIPE_IDLE_MS,
  canRearmSwipe,
  swipeDelta,
  swipeTarget
} from './sessionSwipe'

describe('session swipe intent', () => {
  it('commits quickly while leaving a short smooth transition', () => {
    expect(SWIPE_IDLE_MS).toBeLessThanOrEqual(100)
    expect(SWIPE_COMMIT_MS).toBeLessThanOrEqual(180)
  })
  it('leaves vertical and diagonal scrolling alone', () => {
    expect(swipeDelta(20, 40, 0)).toBe(0)
    expect(swipeDelta(40, 35, 0)).toBe(0)
    expect(swipeDelta(40, 3, 0)).toBe(40)
  })
  it('normalizes line and page wheel units', () => {
    expect(swipeDelta(3, 0, 1)).toBe(48)
    expect(swipeDelta(1, 0, 2)).toBe(240)
  })
  it('requires deliberate travel and never skips or wraps tabs', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(swipeTarget(ids, 'b', 20)).toBeNull()
    expect(swipeTarget(ids, 'b', 32)).toBe('c')
    expect(swipeTarget(ids, 'b', 2000)).toBe('c')
    expect(swipeTarget(ids, 'b', -2000)).toBe('a')
    expect(swipeTarget(ids, 'a', -200)).toBeNull()
    expect(swipeTarget(ids, 'd', 200)).toBeNull()
    expect(swipeTarget(ids, 'missing', 200)).toBeNull()
  })
  it('accepts a fresh flick without waiting for the old momentum to fully stop', () => {
    expect(canRearmSwipe(46, 8, 1)).toBe(true)
    expect(canRearmSwipe(10, -8, 1)).toBe(true)
    expect(canRearmSwipe(30, 2, 1)).toBe(false)
    expect(canRearmSwipe(30, 8, 1, 12)).toBe(false)
  })
  it('recognises a same-direction flick while the momentum tail is still alive', () => {
    // The tail produced peaks of 12; a flick twice as strong starts at once.
    expect(canRearmSwipe(10, 40, 1, 12)).toBe(true)
    // Residue well below the peak stays swallowed.
    expect(canRearmSwipe(10, 9, 1, 12)).toBe(false)
    // A nearly dead tail (peak 1) lets a modest flick through immediately.
    expect(canRearmSwipe(10, 9, 1, 1)).toBe(true)
    // Zero and sub-threshold deltas never rearm.
    expect(canRearmSwipe(10, 0, 1, 0)).toBe(false)
    expect(canRearmSwipe(10, 3, 1, 0)).toBe(false)
  })
})
