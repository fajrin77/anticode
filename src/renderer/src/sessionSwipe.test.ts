import { describe, expect, it } from 'vitest'
import { SWIPE_COMMIT_MS, SWIPE_IDLE_MS, swipeDelta, swipeTarget } from './sessionSwipe'

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
})
