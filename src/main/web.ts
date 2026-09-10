import type { WebSession, WebTab } from '@shared/ipc'

/**
 * anticode's own browser, one per session.
 *
 * The state lives here rather than in the renderer because the agent is what
 * opens pages, and because the phone has to see the same pages the desktop
 * does. Deliberately free of `electron` and `playwright` imports: the browser
 * tools reach into this module, and their unit tests run in plain Node.
 */
export interface WebRecord {
  tabs: WebTab[]
  activeTabId: string
  hidden: boolean
  full: boolean
}

const pages = new Map<string, WebRecord>()
let sink: ((sessions: WebSession[]) => void) | null = null
let closer: ((sessionId: string) => void) | null = null
let counter = 0

/** Installed once by ipc registration; fans changes out to every viewer. */
export function setWebSink(next: (sessions: WebSession[]) => void): void {
  sink = next
}

/** Installed once by ipc registration; tears down a forgotten pane's mirror. */
export function setWebCloser(next: (sessionId: string) => void): void {
  closer = next
}

export function listWeb(): WebSession[] {
  return [...pages.entries()].map(([sessionId, record]) => ({ sessionId, ...record }))
}

function announce(): void {
  sink?.(listWeb())
}

function usable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/** "localhost:5173" is what anyone types; the scheme is filled in for them. */
function withScheme(url: string): string {
  const typed = url.trim()
  return typed === '' || usable(typed) ? typed : `http://${typed}`
}

function newTab(url = '', title = ''): WebTab {
  counter += 1
  return { id: `tab-${Date.now().toString(36)}-${counter}`, url, title }
}

function blank(url = ''): WebRecord {
  const tab = newTab(url)
  return { tabs: [tab], activeTabId: tab.id, hidden: false, full: false }
}

function activeTab(record: WebRecord): WebTab | undefined {
  return record.tabs.find((tab) => tab.id === record.activeTabId) ?? record.tabs[0]
}

function same(a: WebRecord | undefined, b: WebRecord): boolean {
  if (a === undefined) return false
  return (
    a.hidden === b.hidden &&
    a.full === b.full &&
    a.activeTabId === b.activeTabId &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, index) => {
      const other = b.tabs[index]
      return other !== undefined && tab.id === other.id && tab.url === other.url && tab.title === other.title
    })
  )
}

/**
 * Writes a record back and tells everyone, unless nothing actually changed —
 * the pane reports its own navigations back here, and an echo must not loop.
 */
function commit(sessionId: string, record: WebRecord): void {
  const existing = pages.get(sessionId)
  if (same(existing, record)) return
  pages.set(sessionId, record)
  announce()
}

/**
 * The agent opened a page. It drives one page per session, so what it opens is
 * always the active tab. A pane the user has hidden stays hidden — that is the
 * whole point of hiding it — but its tab keeps up to date, so unhiding lands on
 * the page the agent is actually looking at.
 */
export function noteWebUrl(sessionId: string | undefined, url: string, title = ''): void {
  if (sessionId === undefined || sessionId === '' || !usable(url)) return
  const existing = pages.get(sessionId)
  if (existing === undefined) {
    const tab = newTab(url, title)
    commit(sessionId, { tabs: [tab], activeTabId: tab.id, hidden: false, full: false })
    return
  }
  const target = activeTab(existing)
  if (target === undefined) return
  commit(sessionId, {
    ...existing,
    tabs: existing.tabs.map((tab) => (tab.id === target.id ? { ...tab, url, title } : tab))
  })
}

/**
 * The user asked for this page — from the pane's address bar, or by pressing
 * the browser icon on a session that has none yet. An empty URL opens the pane
 * blank, waiting for an address.
 */
export function openWeb(sessionId: string, url: string, tabId?: string, title?: string): void {
  if (sessionId === '') return
  const next = withScheme(url)
  if (next !== '' && !usable(next)) return
  const existing = pages.get(sessionId)
  if (existing === undefined) {
    commit(sessionId, blank(next))
    return
  }
  const target = existing.tabs.find((tab) => tab.id === tabId) ?? activeTab(existing)
  if (target === undefined) {
    commit(sessionId, { ...blank(next), full: existing.full })
    return
  }
  commit(sessionId, {
    ...existing,
    hidden: false,
    activeTabId: target.id,
    tabs: existing.tabs.map((tab) => {
      if (tab.id !== target.id) return tab
      const moved = next !== '' && next !== tab.url
      return {
        ...tab,
        url: next !== '' ? next : tab.url,
        // A new page has not named itself yet; the old page's name would lie.
        title: title !== undefined ? title : moved ? '' : tab.title
      }
    })
  })
}

/** A second page beside the first, the way a browser opens one. */
export function addWebTab(sessionId: string, url = ''): void {
  if (sessionId === '') return
  const next = withScheme(url)
  if (next !== '' && !usable(next)) return
  const existing = pages.get(sessionId)
  if (existing === undefined) {
    commit(sessionId, blank(next))
    return
  }
  const tab = newTab(next)
  commit(sessionId, {
    ...existing,
    hidden: false,
    tabs: [...existing.tabs, tab],
    activeTabId: tab.id
  })
}

/** Guest events update their own tab without stealing focus or reopening a hidden pane. */
export function reportWebTab(sessionId: string, tabId: string, url: string, title?: string): void {
  const existing = pages.get(sessionId)
  if (existing === undefined || !usable(url)) return
  if (!existing.tabs.some((tab) => tab.id === tabId)) return
  commit(sessionId, {
    ...existing,
    tabs: existing.tabs.map((tab) => tab.id === tabId
      ? { ...tab, url, title: title ?? (url === tab.url ? tab.title : '') }
      : tab)
  })
}

/**
 * Closing the last tab closes the browser, as it does everywhere else — but
 * hiding it rather than forgetting it, so the sticky hide still holds and the
 * icon is what brings it back.
 */
export function closeWebTab(sessionId: string, tabId: string): void {
  const existing = pages.get(sessionId)
  if (existing === undefined) return
  const remaining = existing.tabs.filter((tab) => tab.id !== tabId)
  if (remaining.length === 0) {
    commit(sessionId, { ...blank(), hidden: true, full: false })
    return
  }
  const closedIndex = existing.tabs.findIndex((tab) => tab.id === tabId)
  const neighbour = remaining[Math.min(closedIndex, remaining.length - 1)]
  commit(sessionId, {
    ...existing,
    tabs: remaining,
    activeTabId:
      existing.activeTabId === tabId ? neighbour?.id ?? remaining[0]?.id ?? '' : existing.activeTabId
  })
}

export function selectWebTab(sessionId: string, tabId: string): void {
  const existing = pages.get(sessionId)
  if (existing === undefined || !existing.tabs.some((tab) => tab.id === tabId)) return
  commit(sessionId, { ...existing, activeTabId: tabId })
}

export function setWebVisible(sessionId: string, visible: boolean): void {
  const existing = pages.get(sessionId)
  if (existing === undefined) {
    if (visible) commit(sessionId, blank())
    return
  }
  commit(sessionId, { ...existing, hidden: !visible })
}

/** Whole window versus the right-hand side; the pane keeps its pages either way. */
export function setWebFull(sessionId: string, full: boolean): void {
  const existing = pages.get(sessionId)
  if (existing === undefined) {
    if (full) commit(sessionId, { ...blank(), full: true })
    return
  }
  commit(sessionId, { ...existing, full })
}

/** Forgets the pane; a page the agent opens later starts it over, unhidden. */
export function clearWeb(sessionId: string): void {
  if (!pages.delete(sessionId)) return
  closer?.(sessionId)
  announce()
}

export function webRecord(sessionId: string): WebRecord | null {
  return pages.get(sessionId) ?? null
}

/** The page a viewer should be showing for this session, if any. */
export function activeWebUrl(sessionId: string): string | null {
  const record = pages.get(sessionId)
  if (record === undefined) return null
  const tab = activeTab(record)
  return tab !== undefined && tab.url !== '' ? tab.url : null
}

/**
 * Restores a pane from disk at startup, silently — nobody is listening yet.
 * Panes saved before tabs existed carry a single `url`, and become one tab.
 */
export function restoreWeb(sessionId: string, record: unknown): void {
  if (record === null || typeof record !== 'object') return
  const saved = record as Partial<WebRecord> & { url?: unknown; title?: unknown }
  const tabs: WebTab[] = Array.isArray(saved.tabs)
    ? saved.tabs
        .filter(
          (tab): tab is WebTab =>
            tab !== null &&
            typeof tab === 'object' &&
            typeof (tab as WebTab).id === 'string' &&
            typeof (tab as WebTab).url === 'string' &&
            ((tab as WebTab).url === '' || usable((tab as WebTab).url))
        )
        .map((tab) => ({ id: tab.id, url: tab.url, title: typeof tab.title === 'string' ? tab.title : '' }))
    : typeof saved.url === 'string' && usable(saved.url)
      ? [newTab(saved.url, typeof saved.title === 'string' ? saved.title : '')]
      : []
  if (tabs.length === 0) return
  const active = tabs.find((tab) => tab.id === saved.activeTabId) ?? tabs[0]
  pages.set(sessionId, {
    tabs,
    activeTabId: active?.id ?? '',
    hidden: saved.hidden === true,
    full: saved.full === true
  })
}
