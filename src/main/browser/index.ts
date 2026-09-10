import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'

export interface NetworkRecord {
  method: string
  url: string
  status: number | null
  contentType: string | null
  startedAt: number
}
const MAX_RECORDS = 200
let browser: Promise<Browser> | null = null
const pages = new Map<string, Page>()
const opening = new Map<string, Promise<Page>>()
const records = new Map<string, NetworkRecord[]>()
export class BrowserError extends Error {}

/** Viewport a scope's page is opened with; phone mirrors get a phone's. */
interface PageShape {
  width: number
  height: number
  userAgent?: string
  isMobile?: boolean
}

const DESKTOP: PageShape = { width: 1280, height: 800 }
const PHONE: PageShape = {
  width: 390,
  height: 844,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true
}

async function ensurePage(scope: string, shape: PageShape = DESKTOP): Promise<Page> {
  const existing = pages.get(scope)
  if (existing && !existing.isClosed()) return existing
  const pending = opening.get(scope)
  if (pending) return pending
  const operation = (async () => {
    browser ??= chromium.launch({ headless: true }).catch((error: Error) => {
      browser = null
      throw new BrowserError(`Failed to launch Chromium: ${error.message}. Run "npx playwright install chromium" once in this project.`)
    })
    const instance = await browser
    const page = await instance.newPage({
      viewport: { width: shape.width, height: shape.height },
      ...(shape.userAgent !== undefined ? { userAgent: shape.userAgent } : {}),
      ...(shape.isMobile === true
        ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
        : {})
    })
    page.setDefaultTimeout(30_000)
    pages.set(scope, page)
    records.set(scope, [])
    page.on('request', (request) => {
      const list = records.get(scope) ?? []
      list.push({ method: request.method(), url: request.url(), status: null, contentType: null, startedAt: Date.now() })
      records.set(scope, list.slice(-MAX_RECORDS))
    })
    page.on('response', (response) => {
      const record = records.get(scope)?.findLast((entry) => entry.url === response.url() && entry.status === null)
      if (record) {
        record.status = response.status()
        record.contentType = response.headers()['content-type'] ?? null
      }
    })
    return page
  })()
  opening.set(scope, operation)
  try { return await operation } finally { opening.delete(scope) }
}
export async function withPage<T>(action: (page: Page) => Promise<T>, scope = 'default'): Promise<T> {
  return action(await ensurePage(scope))
}
export function requirePage(scope = 'default'): Page {
  const page = pages.get(scope)
  if (!page || page.isClosed()) throw new BrowserError('No page is open. Call browser_navigate first.')
  return page
}
/**
 * The phone cannot embed the page the desktop embeds — every `localhost` the
 * agent serves lives on the Mac — so it gets a picture instead. The picture is
 * taken in a phone-shaped page of its own rather than the agent's: the site
 * lays itself out for a phone, the whole scrollable height is captured, and
 * the agent's own page is never resized or navigated out from under it.
 */
export async function capturePhonePage(sessionId: string, url: string, reload = false): Promise<Buffer> {
  if (url === '') throw new BrowserError('No page is open in this session.')
  const page = await ensurePage(phoneScope(sessionId), PHONE)
  const at = page.url()
  if (reload && at === url) await page.reload({ waitUntil: 'load', timeout: 30_000 })
  else if (at !== url) await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  return page.screenshot({ type: 'jpeg', quality: 72, fullPage: true })
}

function phoneScope(sessionId: string): string {
  return `phone:${sessionId}`
}

/** Drops the phone's mirror of a session, leaving the agent's page alone. */
export async function closePhonePage(sessionId: string): Promise<void> {
  await closeBrowser(phoneScope(sessionId))
}

export function networkRecords(scope = 'default'): NetworkRecord[] { return records.get(scope) ?? [] }
export function clearNetworkRecords(scope = 'default'): void { records.set(scope, []) }
export async function closeBrowser(scope?: string): Promise<void> {
  if (scope !== undefined) {
    const page = await opening.get(scope)?.catch(() => undefined) ?? pages.get(scope)
    await page?.context().close().catch(() => undefined)
    pages.delete(scope)
    records.delete(scope)
    return
  }
  await Promise.allSettled(opening.values())
  const instance = await browser?.catch(() => undefined)
  await instance?.close().catch(() => undefined)
  browser = null
  pages.clear()
  records.clear()
}
