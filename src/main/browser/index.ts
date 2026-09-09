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

let browser: Browser | null = null
let page: Page | null = null
let records: NetworkRecord[] = []

export class BrowserError extends Error {}

/**
 * One headless browser and one page for the whole app. The agent works on a
 * single page at a time, so extra contexts would only add state to reason about.
 */
async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page

  try {
    browser ??= await chromium.launch({ headless: true })
  } catch (error) {
    throw new BrowserError(
      `Failed to launch Chromium: ${(error as Error).message}. ` +
        'Run "npx playwright install chromium" once in this project.'
    )
  }

  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  page.on('request', (request) => {
    records.push({
      method: request.method(),
      url: request.url(),
      status: null,
      contentType: null,
      startedAt: Date.now()
    })
    if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS)
  })

  page.on('response', (response) => {
    const record = records.findLast((entry) => entry.url === response.url() && entry.status === null)
    if (record) {
      record.status = response.status()
      record.contentType = response.headers()['content-type'] ?? null
    }
  })

  return page
}

export async function withPage<T>(action: (page: Page) => Promise<T>): Promise<T> {
  return action(await ensurePage())
}

/** Throws when nothing has been navigated to yet, so tools can say so clearly. */
export function requirePage(): Page {
  if (!page || page.isClosed()) {
    throw new BrowserError('No page is open. Call browser_navigate first.')
  }
  return page
}

export function networkRecords(): NetworkRecord[] {
  return records
}

export function clearNetworkRecords(): void {
  records = []
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => undefined)
  browser = null
  page = null
  records = []
}
