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
/**
 * Where each tab has been, for Back and Forward from the phone. The desktop
 * pane has its webview's own history; the phone has only this. Kept beside
 * the record, not in it, so the tabs viewers are told about stay as they were.
 */
const histories = new Map<string, { entries: string[]; index: number }>()
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
 * A tab arrived at a URL. Landing on the page just behind or just ahead is
 * read as Back or Forward, the way the desktop webview reports them; anything
 * else is a new page and drops what was ahead.
 */
function visit(tabId: string, typed: string): void {
  if (typed === '') return
  // "http://host:5173" typed and "http://host:5173/" reported are one page.
  let url = typed
  try { url = new URL(typed).href } catch { /* kept as it was */ }
  const history = histories.get(tabId)
  if (history === undefined) {
    histories.set(tabId, { entries: [url], index: 0 })
    return
  }
  if (history.entries[history.index] === url) return
  if (history.entries[history.index - 1] === url) history.index -= 1
  else if (history.entries[history.index + 1] === url) history.index += 1
  else {
    history.entries = [...history.entries.slice(0, history.index + 1), url].slice(-50)
    history.index = history.entries.length - 1
  }
}

/**
 * Writes a record back and tells everyone, unless nothing actually changed,
 * the pane reports its own navigations back here, and an echo must not loop.
 */
function commit(sessionId: string, record: WebRecord): void {
  const existing = pages.get(sessionId)
  for (const tab of record.tabs) visit(tab.id, tab.url)
  for (const tab of existing?.tabs ?? []) {
    if (!record.tabs.some((kept) => kept.id === tab.id)) histories.delete(tab.id)
  }
  if (same(existing, record)) return
  pages.set(sessionId, record)
  announce()
}

/**
 * Back or Forward on the active tab, from the phone. The tab is pointed at
 * the page behind or ahead; the desktop pane follows it like any other page.
 */
export function stepWebHistory(sessionId: string, step: -1 | 1): void {
  const record = pages.get(sessionId)
  if (record === undefined) return
  const tab = activeTab(record)
  const history = tab === undefined ? undefined : histories.get(tab.id)
  const url = history?.entries[(history?.index ?? 0) + step]
  if (tab === undefined || history === undefined || url === undefined) return
  history.index += step
  commit(sessionId, {
    ...record,
    tabs: record.tabs.map((entry) => (entry.id === tab.id ? { ...entry, url, title: '' } : entry))
  })
}

/** Whether the active tab has a page behind it and ahead of it. */
export function webHistoryOf(sessionId: string): { back: boolean; forward: boolean } {
  const record = pages.get(sessionId)
  const tab = record === undefined ? undefined : activeTab(record)
  const history = tab === undefined ? undefined : histories.get(tab.id)
  if (history === undefined) return { back: false, forward: false }
  return { back: history.index > 0, forward: history.index < history.entries.length - 1 }
}

/**
 * The agent opened a page. It drives one page per session, so what it opens is
 * always the active tab. A pane the user has hidden stays hidden, that is the
 * whole point of hiding it, but its tab keeps up to date, so unhiding lands on
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
 * The user asked for this page, from the pane's address bar, or by pressing
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
 * Closing the last tab closes the browser, as it does everywhere else, but
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
  for (const tab of pages.get(sessionId)?.tabs ?? []) histories.delete(tab.id)
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
 * Restores a pane from disk at startup, silently, nobody is listening yet.
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
