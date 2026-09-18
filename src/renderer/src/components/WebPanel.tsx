import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { WebSession, WebTab } from '@shared/ipc'
import type { WebviewElement } from '../webview'

const MIN_WIDTH = 320
const MAX_WIDTH = 1000
const WIDTH_KEY = 'anticode-web-width'

function storedWidth(): number {
  const saved = Number(window.localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(saved) && saved >= MIN_WIDTH ? Math.min(saved, MAX_WIDTH) : 480
}

/** "http://localhost:5173/orders" → "localhost:5173", for a tab's label. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function labelOf(tab: WebTab): string {
  if (tab.title !== '') return tab.title
  return tab.url !== '' ? hostOf(tab.url) : 'New tab'
}

/** What someone types in the address bar is rarely a whole URL. */
function normalise(typed: string): string {
  const text = typed.trim()
  if (text === '') return ''
  return /^https?:\/\//i.test(text) ? text : `http://${text}`
}

function IconButton({
  label,
  onClick,
  disabled,
  active,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled === true}
      className={`glass-ghost flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:text-brand disabled:text-faint disabled:hover:text-faint ${
        active === true ? 'text-brand' : 'text-dim'
      }`}
    >
      {children}
    </button>
  )
}

interface GuestState {
  loading: boolean
  back: boolean
  forward: boolean
  failure: string | null
}

const IDLE: GuestState = { loading: false, back: false, forward: false, failure: null }

/**
 * One tab's page. Background tabs stay mounted but unpainted, the way a
 * browser keeps them, switching back must not reload what was already there.
 */
function Guest({
  tab,
  active,
  sessionId,
  onElement,
  onState
}: {
  tab: WebTab
  active: boolean
  sessionId: string
  onElement: (tabId: string, element: WebviewElement | null) => void
  onState: (tabId: string, state: GuestState) => void
}): JSX.Element {
  const [element, setElement] = useState<WebviewElement | null>(null)

  // The guest appears only once there is a page to show, which is later than
  // this component mounts, so its listeners hang on the element arriving.
  const attach = useCallback(
    (node: HTMLElement | null) => {
      const guest = node as WebviewElement | null
      setElement(guest)
      onElement(tab.id, guest)
    },
    [onElement, tab.id]
  )

  useEffect(() => {
    if (element === null) return
    let state: GuestState = { ...IDLE, loading: true }
    const push = (patch: Partial<GuestState>): void => {
      state = { ...state, ...patch }
      onState(tab.id, state)
    }
    const onNavigate = (event: Event): void => {
      const url = String((event as Event & { url?: string }).url ?? element.getURL())
      push({ failure: null, back: element.canGoBack(), forward: element.canGoForward() })
      // A page the guest reached on its own, a link, a redirect, is still
      // this tab's page, so the record follows it and a restart returns here.
      // A move inside the same document keeps its title; a new document has
      // not announced one yet, and page-title-updated will.
      if (event.type === 'did-navigate-in-page') {
        void window.anticode.reportWebTab(sessionId, tab.id, url, element.getTitle())
      } else {
        void window.anticode.reportWebTab(sessionId, tab.id, url)
      }
    }
    const onTitle = (event: Event): void => {
      const title = String((event as Event & { title?: string }).title ?? '')
      void window.anticode.reportWebTab(sessionId, tab.id, element.getURL(), title)
    }
    const onStart = (): void => push({ loading: true })
    const onStop = (): void =>
      push({ loading: false, back: element.canGoBack(), forward: element.canGoForward() })
    const onFail = (event: Event): void => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string }
      // -3 is an aborted load: a redirect or a second navigation, not a fault.
      if (detail.errorCode === -3) return
      push({ loading: false, failure: detail.errorDescription ?? 'The page could not be loaded' })
    }
    element.addEventListener('did-navigate', onNavigate)
    element.addEventListener('did-navigate-in-page', onNavigate)
    element.addEventListener('did-start-loading', onStart)
    element.addEventListener('did-stop-loading', onStop)
    element.addEventListener('did-fail-load', onFail)
    element.addEventListener('page-title-updated', onTitle)
    return () => {
      element.removeEventListener('page-title-updated', onTitle)
      element.removeEventListener('did-navigate', onNavigate)
      element.removeEventListener('did-navigate-in-page', onNavigate)
      element.removeEventListener('did-start-loading', onStart)
      element.removeEventListener('did-stop-loading', onStop)
      element.removeEventListener('did-fail-load', onFail)
    }
  }, [element, onState, sessionId, tab.id])

  useEffect(() => () => onElement(tab.id, null), [onElement, tab.id])

  return (
    <webview
      ref={attach}
      src={tab.url}
      partition={`persist:anticode-web-${sessionId}`}
      className="h-full w-full"
      style={{ display: active ? 'flex' : 'none' }}
    />
  )
}

interface WebPanelProps {
  sessionId: string
  entry: WebSession
  /** False while the pane is folding away; it keeps its width animation. */
  open: boolean
  onHide: () => void
}

export function WebPanel({ sessionId, entry, open, onHide }: WebPanelProps): JSX.Element {
  const guests = useRef(new Map<string, WebviewElement>())
  const [states, setStates] = useState<Record<string, GuestState>>({})
  const [width, setWidth] = useState(storedWidth)
  const [dragging, setDragging] = useState(false)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  // The pane slides in rather than appearing: the transcript beside it is
  // moving too, and an instant jump reads as the layout breaking.
  const [entered, setEntered] = useState(false)
  // A guest that has never loaded must not linger as a live page once hidden.
  const [mounted, setMounted] = useState(open)

  const active = entry.tabs.find((tab) => tab.id === entry.activeTabId) ?? entry.tabs[0]
  const activeId = active?.id ?? ''
  const state = states[activeId] ?? IDLE

  const onElement = useCallback((tabId: string, element: WebviewElement | null) => {
    if (element === null) guests.current.delete(tabId)
    else guests.current.set(tabId, element)
  }, [])

  const onState = useCallback((tabId: string, next: GuestState) => {
    setStates((all) => ({ ...all, [tabId]: next }))
  }, [])

  const guest = (): WebviewElement | undefined => guests.current.get(activeId)

  useEffect(() => {
    if (!open) return
    setMounted(true)
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (open) return
    setEntered(false)
    const timer = window.setTimeout(() => setMounted(false), 220)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!editing) setAddress(active?.url ?? '')
  }, [active?.url, activeId, editing])

  useEffect(() => {
    window.localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  useEffect(() => {
    if (!dragging) return
    function onMove(event: MouseEvent): void {
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - event.clientX)))
    }
    function onUp(): void {
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  function go(): void {
    const url = normalise(address)
    if (url === '') return
    setEditing(false)
    void window.anticode.openWebUrl(sessionId, url, activeId)
  }

  const full = entry.full
  const failure = state.failure

  return (
    <div
      data-web-panel
      data-web-full={full ? 'true' : undefined}
      style={full ? undefined : { width: entered ? width : 0 }}
      className={`relative flex shrink-0 flex-col overflow-hidden bg-surface transition-[width] duration-200 ease-out ${
        full ? 'w-full flex-1' : 'border-l border-line'
      }`}
    >
      {/* Dragging over a live guest never reaches this document, so the pane
          puts a sheet over itself for the length of the drag. */}
      {dragging && <div className="absolute inset-0 z-20" />}
      {!full && (
        <button
          type="button"
          aria-label="Resize browser"
          onMouseDown={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          className={`absolute top-0 left-0 z-10 h-full w-1 cursor-col-resize transition-colors hover:bg-brand ${
            dragging ? 'bg-brand' : 'bg-transparent'
          }`}
        />
      )}

      <div className="flex h-full min-w-0 flex-col" style={full ? undefined : { width }}>
        {/* Tabs first, the way a browser stacks them: what is open, then how
            to move around inside it. */}
        <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-soft px-1.5">
          {entry.tabs.map((tab) => (
            <div
              key={tab.id}
              className="glass-ghost group flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2"
            >
              <button
                type="button"
                onClick={() => void window.anticode.selectWebTab(sessionId, tab.id)}
                title={tab.url !== '' ? tab.url : 'New tab'}
                className={`min-w-0 max-w-40 truncate text-[12px] transition-colors group-hover:text-brand ${
                  tab.id === activeId ? 'text-text' : 'text-dim'
                }`}
              >
                {labelOf(tab)}
              </button>
              <button
                type="button"
                onClick={() => void window.anticode.closeWebTab(sessionId, tab.id)}
                aria-label="Close tab"
                className="shrink-0 text-faint opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-brand focus-visible:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => void window.anticode.addWebTab(sessionId)}
            aria-label="New tab"
            className="glass-ghost flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-faint hover:text-brand"
          >
            +
          </button>
        </div>

        <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
          <IconButton label="Back" disabled={!state.back} onClick={() => guest()?.goBack()}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10 3 5 8l5 5" />
            </svg>
          </IconButton>
          <IconButton label="Forward" disabled={!state.forward} onClick={() => guest()?.goForward()}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 3l5 5-5 5" />
            </svg>
          </IconButton>
          <IconButton
            label={state.loading ? 'Stop' : 'Reload'}
            onClick={() => (state.loading ? guest()?.stop() : guest()?.reload())}
          >
            {state.loading ? (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
                <rect x="4" y="4" width="8" height="8" rx="1.5" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M13 8a5 5 0 1 1-1.6-3.7" />
                <path d="M13 2.5V5h-2.6" />
              </svg>
            )}
          </IconButton>

          <input
            value={address}
            spellCheck={false}
            placeholder="localhost:5173"
            onChange={(event) => {
              setEditing(true)
              setAddress(event.target.value)
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') go()
              if (event.key === 'Escape') {
                setEditing(false)
                setAddress(active?.url ?? '')
                event.currentTarget.blur()
              }
            }}
            aria-label="Address"
            className="glass-field min-w-0 flex-1 rounded-md border px-2.5 py-1 font-mono text-[12px] text-dim transition-colors outline-none placeholder:text-faint focus:text-text"
          />

          <IconButton
            label="Open in the system browser"
            disabled={active === undefined || active.url === ''}
            onClick={() => window.open(active?.url ?? '', '_blank')}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 3h4v4" />
              <path d="M13 3 7.5 8.5" />
              <path d="M12 9.5V13H3V4h3.5" />
            </svg>
          </IconButton>
          {/* Full size takes the whole window; the transcript is still a click
              away, so the pane never becomes a place you get stuck in. */}
          <IconButton
            label={full ? 'Shrink to the side' : 'Fill the window'}
            active={full}
            onClick={() => void window.anticode.setWebFull(sessionId, !full)}
          >
            {full ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6.5 2v4.5H2M9.5 14V9.5H14" />
                <path d="M6.5 6.5 2.5 2.5M9.5 9.5l4 4" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9.5 2H14v4.5M6.5 14H2V9.5" />
                <path d="M14 2l-4.5 4.5M2 14l4.5-4.5" />
              </svg>
            )}
          </IconButton>
          <IconButton label="Hide browser" onClick={onHide}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </IconButton>
        </header>

        {/* A browser's canvas is white: a page that sets no background of its
            own must not come out black-on-charcoal because the guest is
            transparent over the app. The blank tab keeps the app's ground. */}
        <div
          className={`relative min-h-0 flex-1 ${
            active !== undefined && active.url !== '' ? 'bg-white' : 'bg-bg'
          }`}
        >
          {mounted &&
            entry.tabs
              .filter((tab) => tab.url !== '')
              .map((tab) => (
                <Guest
                  key={tab.id}
                  tab={tab}
                  active={tab.id === activeId}
                  sessionId={sessionId}
                  onElement={onElement}
                  onState={onState}
                />
              ))}

          {(active === undefined || active.url === '') && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="text-[13px] text-dim">Browser</span>
              <span className="text-[12px] text-faint">
                Type an address above, or let the agent open a page, a dev server it
                starts lands here by itself.
              </span>
            </div>
          )}

          {failure !== null && (
            <div className="absolute inset-x-0 bottom-0 bg-raised px-3 py-2 text-[12px] text-del">
              {failure}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
