import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/session'
import {
  SWIPE_BOUNCE_MS,
  SWIPE_COMMIT_MS,
  SWIPE_IDLE_MS,
  swipeDelta,
  swipeTarget
} from '../sessionSwipe'

/** One shared recognizer for the tab strip and conversation, with release-to-commit. */
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
    let frame = 0
    let busy = false
    let suppressTail = false
    let disposed = false
    let animation: Animation | undefined
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const content = () => host.querySelector<HTMLElement>('[data-session-slide]')
    const reset = () => { distance = 0; axis = null; origin = null }
    const restore = () => {
      const pane = content()
      if (pane) { pane.style.transform = ''; pane.style.willChange = '' }
    }
    const finish = async () => {
      cancelAnimationFrame(frame)
      const state = useSessionStore.getState()
      if (origin !== state.activeSessionId) { restore(); reset(); return }
      const target = swipeTarget(state.sessions.filter(s => !s.closed).map(s => s.id), origin, distance)
      const pane = content()
      const from = pane?.style.transform || 'translateX(0px)'
      const sign = Math.sign(distance)
      busy = true
      suppressTail = true
      restore()
      try {
        if (!target && pane && !reduced.matches) {
          animation = pane.animate([
            { transform: from },
            { transform: 'translateX(0px)', opacity: 1 }
          ], { duration: SWIPE_BOUNCE_MS, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
          await animation.finished
        }
        if (disposed || useSessionStore.getState().activeSessionId !== origin) return
        if (target && useSessionStore.getState().sessions.some(s => s.id === target && !s.closed)) {
          if (reduced.matches) {
            select(target)
          } else {
            // Select immediately, then settle only the destination pane inside
            // the clipped session container. A document View Transition lives
            // above every z-index and let transcript text flash over the tab
            // bar; a local animation can never cross that boundary.
            select(target)
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const nextPane = content()
            if (nextPane !== null) {
              animation = nextPane.animate([
                { transform: `translateX(${sign * 36}px)`, opacity: .72 },
                { transform: 'translateX(0px)', opacity: 1 }
              ], { duration: SWIPE_COMMIT_MS, easing: 'cubic-bezier(.22,1,.36,1)' })
              await animation.finished
            }
          }
        }
      } catch { /* Unmounting or a direct tab click can cancel an animation. */ }
      finally {
        animation?.cancel()
        busy = false
        reset()
        restore()
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
      const quiet = now - lastEvent > SWIPE_IDLE_MS
      lastEvent = now
      // Momentum after a committed slide belongs to that slide, even if it
      // outlasts the animation. A new gesture needs a quiet interval.
      if (busy || (suppressTail && !quiet)) {
        if (swipeDelta(event.deltaX, event.deltaY, event.deltaMode)) event.preventDefault()
        return
      }
      if (quiet) { clearTimeout(timer); reset(); suppressTail = false }
      if (axis === null) {
        if (Math.max(Math.abs(event.deltaX), Math.abs(event.deltaY)) === 0) return
        axis = swipeDelta(event.deltaX, event.deltaY, event.deltaMode) === 0 ? 'y' : 'x'
        origin = useSessionStore.getState().activeSessionId
      }
      if (axis === 'y') return
      event.preventDefault()
      distance += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 240 : 1)
      clearTimeout(timer)
      const state = useSessionStore.getState()
      const ids = state.sessions.filter(s => !s.closed).map(s => s.id)
      const neighbour = swipeTarget(ids, origin, distance)
      // Commit while the fingers are still moving. Waiting for the idle timer
      // used to produce the visible arrow-then-pause beat the user felt.
      if (neighbour !== null) {
        cancelAnimationFrame(frame)
        void finish()
        return
      }
      timer = window.setTimeout(() => { void finish() }, SWIPE_IDLE_MS)
      // Track the fingers in this very event. Deferring this by one animation
      // frame left a visible still beat before the session began moving.
      const pane = content()
      if (pane && !reduced.matches) {
        pane.style.willChange = 'transform'
        pane.style.transform = `translateX(${-Math.sign(distance) * Math.min(80, Math.abs(distance) * .45)}px)`
      }
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      disposed = true
      host.removeEventListener('wheel', onWheel)
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      animation?.cancel()
      restore()
    }
  }, [enabled, select])
  return root
}
