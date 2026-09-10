import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeWebUrl,
  addWebTab,
  clearWeb,
  closeWebTab,
  listWeb,
  noteWebUrl,
  openWeb,
  reportWebTab,
  restoreWeb,
  selectWebTab,
  setWebCloser,
  setWebFull,
  setWebSink,
  setWebVisible,
  stepWebHistory,
  webHistoryOf,
  webRecord
} from './web'

const SESSION = 'session-1'

function urls(sessionId = SESSION): string[] {
  return webRecord(sessionId)?.tabs.map((tab) => tab.url) ?? []
}

describe('browser pane state', () => {
  beforeEach(() => {
    setWebSink(() => {})
    setWebCloser(() => {})
    for (const entry of listWeb()) clearWeb(entry.sessionId)
  })

  it('opens a pane with one tab when the agent navigates', () => {
    noteWebUrl(SESSION, 'http://localhost:5173/', 'Dev')
    const pane = webRecord(SESSION)
    expect(pane).toMatchObject({ hidden: false, full: false })
    expect(pane?.tabs).toEqual([{ id: pane?.activeTabId, url: 'http://localhost:5173/', title: 'Dev' }])
  })

  it('ignores sessionless calls and non-web schemes', () => {
    noteWebUrl(undefined, 'http://localhost:5173/')
    noteWebUrl(SESSION, 'file:///etc/passwd')
    expect(listWeb()).toEqual([])
  })

  it('keeps a hidden pane hidden when a later page arrives', () => {
    noteWebUrl(SESSION, 'http://localhost:5173/')
    setWebVisible(SESSION, false)
    noteWebUrl(SESSION, 'http://localhost:5173/orders', 'Orders')
    expect(webRecord(SESSION)?.hidden).toBe(true)
    expect(activeWebUrl(SESSION)).toBe('http://localhost:5173/orders')
  })

  it('shows the pane again when the user asks for it', () => {
    noteWebUrl(SESSION, 'http://localhost:5173/')
    setWebVisible(SESSION, false)
    setWebVisible(SESSION, true)
    expect(webRecord(SESSION)?.hidden).toBe(false)
  })

  it('opens a blank pane for a session that has no page', () => {
    setWebVisible(SESSION, true)
    expect(urls()).toEqual([''])
  })

  it('fills in the scheme someone leaves off', () => {
    openWeb(SESSION, 'localhost:4000')
    expect(activeWebUrl(SESSION)).toBe('http://localhost:4000')
  })

  it('says nothing when a reported page changes nothing', () => {
    noteWebUrl(SESSION, 'http://localhost:5173/', 'Dev')
    const sink = vi.fn()
    setWebSink(sink)
    // The pane reports its own navigations back; an echo must not loop.
    openWeb(SESSION, 'http://localhost:5173/')
    expect(sink).not.toHaveBeenCalled()
  })

  describe('tabs', () => {
    it('keeps the selected tab and visibility when a background guest reports navigation', () => {
      openWeb(SESSION, 'http://a.test/')
      const first = webRecord(SESSION)!.activeTabId
      addWebTab(SESSION, 'http://b.test/')
      const second = webRecord(SESSION)!.activeTabId
      setWebVisible(SESSION, false)
      reportWebTab(SESSION, first, 'http://a.test/redirect', 'Background')
      expect(webRecord(SESSION)).toMatchObject({ activeTabId: second, hidden: true })
      expect(webRecord(SESSION)!.tabs[0]).toMatchObject({ url: 'http://a.test/redirect', title: 'Background' })
      closeWebTab(SESSION, first)
      reportWebTab(SESSION, first, 'http://a.test/late', 'Late event')
      expect(urls()).toEqual(['http://b.test/'])
      clearWeb(SESSION)
      reportWebTab(SESSION, second, 'http://b.test/late')
      expect(webRecord(SESSION)).toBeNull()
    })
    it('opens a new tab beside the first and makes it active', () => {
      noteWebUrl(SESSION, 'http://localhost:5173/')
      addWebTab(SESSION, 'localhost:6006')
      expect(urls()).toEqual(['http://localhost:5173/', 'http://localhost:6006'])
      expect(activeWebUrl(SESSION)).toBe('http://localhost:6006')
    })

    it('points the agent at the active tab only', () => {
      noteWebUrl(SESSION, 'http://localhost:5173/')
      addWebTab(SESSION, 'http://localhost:6006/')
      noteWebUrl(SESSION, 'http://localhost:6006/story')
      expect(urls()).toEqual(['http://localhost:5173/', 'http://localhost:6006/story'])
    })

    it('navigates the tab it is told to, not whichever is active', () => {
      noteWebUrl(SESSION, 'http://localhost:5173/')
      const first = webRecord(SESSION)?.activeTabId ?? ''
      addWebTab(SESSION)
      openWeb(SESSION, 'http://localhost:5173/cart', first)
      expect(urls()).toEqual(['http://localhost:5173/cart', ''])
    })

    it('switches between tabs', () => {
      noteWebUrl(SESSION, 'http://localhost:5173/')
      const first = webRecord(SESSION)?.activeTabId ?? ''
      addWebTab(SESSION, 'http://localhost:6006/')
      selectWebTab(SESSION, first)
      expect(activeWebUrl(SESSION)).toBe('http://localhost:5173/')
    })

    it('closing the active tab lands on its neighbour', () => {
      noteWebUrl(SESSION, 'http://a.test/')
      addWebTab(SESSION, 'http://b.test/')
      const second = webRecord(SESSION)?.activeTabId ?? ''
      addWebTab(SESSION, 'http://c.test/')
      selectWebTab(SESSION, second)
      closeWebTab(SESSION, second)
      expect(urls()).toEqual(['http://a.test/', 'http://c.test/'])
      expect(activeWebUrl(SESSION)).toBe('http://c.test/')
    })

    it('closing the last tab hides the browser rather than forgetting it', () => {
      noteWebUrl(SESSION, 'http://a.test/')
      closeWebTab(SESSION, webRecord(SESSION)?.activeTabId ?? '')
      expect(webRecord(SESSION)).toMatchObject({ hidden: true, full: false })
      expect(urls()).toEqual([''])
    })
  })

  it('fills the window and shrinks back, keeping its pages', () => {
    noteWebUrl(SESSION, 'http://localhost:5173/')
    setWebFull(SESSION, true)
    expect(webRecord(SESSION)?.full).toBe(true)
    setWebFull(SESSION, false)
    expect(webRecord(SESSION)?.full).toBe(false)
    expect(activeWebUrl(SESSION)).toBe('http://localhost:5173/')
  })

  it('restores tabs from disk, and upgrades a pane saved before tabs existed', () => {
    restoreWeb(SESSION, {
      tabs: [
        { id: 'a', url: 'http://localhost:3000/', title: 'App' },
        { id: 'b', url: 'about:blank', title: '' }
      ],
      activeTabId: 'a',
      hidden: true,
      full: true
    })
    restoreWeb('session-2', { url: 'http://localhost:4000/', title: 'Old', hidden: false })
    restoreWeb('session-3', { url: 'about:blank' })
    restoreWeb('session-4', null)
    expect(webRecord(SESSION)).toEqual({
      tabs: [{ id: 'a', url: 'http://localhost:3000/', title: 'App' }],
      activeTabId: 'a',
      hidden: true,
      full: true
    })
    expect(activeWebUrl('session-2')).toBe('http://localhost:4000/')
    expect(listWeb().map((entry) => entry.sessionId).sort()).toEqual([SESSION, 'session-2'])
  })

  it('forgets a pane with its session, and takes its phone mirror down', () => {
    const closer = vi.fn()
    setWebCloser(closer)
    noteWebUrl(SESSION, 'http://localhost:5173/')
    clearWeb(SESSION)
    expect(webRecord(SESSION)).toBeNull()
    expect(closer).toHaveBeenCalledWith(SESSION)
  })

  it('steps Back and Forward through the pages the active tab has visited', () => {
    openWeb(SESSION, 'http://localhost:5173/')
    openWeb(SESSION, 'http://localhost:5173/orders')
    const tabId = webRecord(SESSION)!.activeTabId
    // The desktop webview reports a link it followed.
    reportWebTab(SESSION, tabId, 'http://localhost:5173/orders/7')
    expect(webHistoryOf(SESSION)).toEqual({ back: true, forward: false })
    stepWebHistory(SESSION, -1)
    stepWebHistory(SESSION, -1)
    expect(urls()).toEqual(['http://localhost:5173/'])
    expect(webHistoryOf(SESSION)).toEqual({ back: false, forward: true })
    stepWebHistory(SESSION, 1)
    expect(urls()).toEqual(['http://localhost:5173/orders'])
    // The desktop pane echoing the page it was pointed at moves nothing.
    reportWebTab(SESSION, tabId, 'http://localhost:5173/orders')
    expect(webHistoryOf(SESSION)).toEqual({ back: true, forward: true })
    // The pane reporting the root with its trailing slash is the same page.
    stepWebHistory(SESSION, -1)
    reportWebTab(SESSION, tabId, 'http://localhost:5173/')
    expect(webHistoryOf(SESSION)).toEqual({ back: false, forward: true })
    stepWebHistory(SESSION, 1)
    // A new page drops what was ahead, as a browser does.
    openWeb(SESSION, 'http://localhost:5173/new')
    expect(webHistoryOf(SESSION)).toEqual({ back: true, forward: false })
    stepWebHistory(SESSION, 1)
    expect(urls()).toEqual(['http://localhost:5173/new'])
  })
})
