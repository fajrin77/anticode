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

async function ensurePage(scope: string): Promise<Page> {
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
    const page = await instance.newPage({ viewport: { width: 1280, height: 800 } })
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
