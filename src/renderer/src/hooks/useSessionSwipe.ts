import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/session'
import {
  SWIPE_FADE_IN_MS,
  SWIPE_FADE_OUT_MS,
  SWIPE_IDLE_MS,
  SWIPE_SETTLE_DELTA,
  SWIPE_THRESHOLD,
  canRearmSwipe,
  swipeDelta,
  swipeTarget
} from '../sessionSwipe'

/** One shared recognizer for the tab strip and conversation.
 *
 * The tab changes on release, not while the fingers are still moving: the
 * gesture only records a direction and how far it travelled, and the swap
 * happens once the momentum has clearly eased. The session and its composer
 * never slide, content stays centred and only fades back in, so a switch
 * reads as a change of state rather than a sideways motion. */
export function useSessionSwipe(enabled: boolean, select: (id: string) => void) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = root.current
    if (!host || !enabled) return
    let distance = 0
    let axis: 'x' | 'y' | null = null
    let lastEvent = 0
    let origin: string | null = null
    let timer = 0
    let busy = false
    let suppressTail = false
    let tailDirection = 0
    let tailPeak = 0
    let disposed = false
    let animation: Animation | undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const content = () => host.querySelector<HTMLElement>('[data-session-slide]')
    const reset = () => { distance = 0; axis = null; origin = null }
    const settle = async () => {
      clearTimeout(timer)
      const state = useSessionStore.getState()
      const from = origin
      const travelled = distance
      const sign = Math.sign(travelled)
      reset()
      if (from === null || from !== state.activeSessionId) return
      const ids = state.sessions.filter(s => !s.closed).map(s => s.id)
      const target = swipeTarget(ids, from, travelled)
      if (target === null || !state.sessions.some(s => s.id === target && !s.closed)) return
      busy = true
      suppressTail = true
      tailDirection = sign
      tailPeak = 0
      try {
        if (!reduced.matches) {
          // The old session dims out first, a real fade, not a one-frame
          // blink, then the swap happens while the pane is dark, and the
          // new session eases back in. The pane itself never slides.
          const pane = content()
          if (pane !== null) {
            const out = pane.animate(
              [{ opacity: 1 }, { opacity: .12 }],
              { duration: SWIPE_FADE_OUT_MS, easing: 'ease-in' }
            )
            try { await out.finished } catch { /* unmounted mid-fade */ }
          }
        }
        if (disposed) return
        select(target)
        if (reduced.matches) return
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const pane = content()
        if (pane !== null && !disposed) {
          animation = pane.animate(
            [{ opacity: .12 }, { opacity: 1 }],
            { duration: SWIPE_FADE_IN_MS, easing: 'ease-out' }
          )
          await animation.finished
        }
      } catch { /* Unmounting or a direct tab click can cancel an animation. */ }
      finally {
        animation?.cancel()
        busy = false
      }
    }
    const onWheel = (event: WheelEvent) => {
      const target = event.target
      if (!(target instanceof Element) || event.ctrlKey || event.metaKey || event.shiftKey) return
      const surface = target.closest('[data-session-swipe], [data-session-tabs]')
      if (!surface || target.closest('textarea,input,select,[contenteditable="true"],[role="dialog"],.menu-glass')) return
      // A code block/table owns its entire horizontal gesture, including at its edges.
      for (let node = target; node && node !== surface; node = node.parentElement!) {
        const style = getComputedStyle(node)
        if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(style.overflowX)) return
      }
      const now = performance.now()
      const gap = now - lastEvent
      const quiet = gap > SWIPE_IDLE_MS
      const horizontal = swipeDelta(event.deltaX, event.deltaY, event.deltaMode)
      lastEvent = now
      // Do not compete with the swap. Once it settles, the recognizer below can
      // tell a fresh flick from the old momentum tail.
      if (busy) {
        if (horizontal) event.preventDefault()
        return
      }
      // A new strong flick can start before macOS has completely stopped
      // emitting the previous gesture's tiny momentum events.
      if (suppressTail && canRearmSwipe(gap, horizontal, tailDirection, tailPeak)) {
        clearTimeout(timer)
        reset()
        suppressTail = false
        tailPeak = 0
      }
      if (quiet) { clearTimeout(timer); reset(); suppressTail = false; tailPeak = 0 }
      if (suppressTail) {
        if (horizontal) event.preventDefault()
        tailPeak = Math.max(tailPeak, Math.abs(horizontal))
        return
      }
      if (axis === null) {
        if (Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) === 0) return
        axis = horizontal === 0 ? 'y' : 'x'
        origin = useSessionStore.getState().activeSessionId
      }
      if (axis === 'y') return
      event.preventDefault()
      distance += horizontal
      clearTimeout(timer)
      // Release is when the momentum eases: once the run is long enough and the
      // latest step has dropped to a settle speed, the neighbour is committed.
      // A slow deliberate drag that never speeds up falls back to the idle gap.
      if (Math.abs(distance) >= SWIPE_THRESHOLD && Math.abs(horizontal) <= SWIPE_SETTLE_DELTA) {
        void settle()
        return
      }
      timer = window.setTimeout(() => { void settle() }, SWIPE_IDLE_MS)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      disposed = true
      host.removeEventListener('wheel', onWheel)
      clearTimeout(timer)
      animation?.cancel()
    }
  }, [enabled, select])
  return root
}