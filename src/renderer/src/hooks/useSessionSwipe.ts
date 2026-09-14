import { useEffect, useRef } from 'react'
import { useSessionStore } from '../store/session'
import { SWIPE_IDLE_MS, SWIPE_THRESHOLD, swipeDelta, swipeTarget } from '../sessionSwipe'

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
      delete host.dataset.swipeDirection
      delete host.dataset.swipeReady
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
        if (pane && !reduced.matches) {
          animation = pane.animate([
            { transform: from },
            { transform: target ? `translateX(${-sign * 100}px)` : 'translateX(0px)', opacity: target ? 0 : 1 }
          ], { duration: target ? 160 : 240, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
          await animation.finished
        }
        if (disposed || useSessionStore.getState().activeSessionId !== origin) return
        if (target && useSessionStore.getState().sessions.some(s => s.id === target && !s.closed)) {
          select(target)
          animation?.cancel()
          if (pane && !reduced.matches) {
            animation = pane.animate([
              { transform: `translateX(${sign * 70}px)`, opacity: 0 },
              { transform: 'translateX(0px)', opacity: 1 }
            ], { duration: 280, easing: 'cubic-bezier(.22,1,.36,1)' })
            await animation.finished
          }
        }
      } catch { /* Unmounting or a direct tab click can cancel an animation. */ }
      finally { animation?.cancel(); busy = false; reset(); restore() }
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
      timer = window.setTimeout(() => { void finish() }, SWIPE_IDLE_MS)
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const state = useSessionStore.getState()
        if (state.activeSessionId !== origin) { restore(); return }
        const ids = state.sessions.filter(s => !s.closed).map(s => s.id)
        const neighbour = swipeTarget(ids, origin, Math.sign(distance) * SWIPE_THRESHOLD)
        host.dataset.swipeDirection = distance > 0 ? 'next' : 'previous'
        host.dataset.swipeReady = neighbour && Math.abs(distance) >= SWIPE_THRESHOLD ? 'true' : 'false'
        const pane = content()
        if (pane && !reduced.matches) {
          pane.style.willChange = 'transform'
          pane.style.transform = `translateX(${-Math.sign(distance) * Math.min(80, Math.abs(distance) * (neighbour ? .45 : .12))}px)`
        }
      })
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
