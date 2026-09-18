import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { searchScope, withPage } from '../browser'

/*
 * Finding a page, as opposed to reading one.
 *
 * fetch_url and browser_navigate can only reach an address the model already
 * knows, which leaves it guessing URLs for anything it has not memorised. This
 * tool answers the other half: a query in, ranked results out, each with the
 * URL the other two tools then read.
 *
 * Three backends, tried in order, so it works with nothing configured and gets
 * better when something is:
 *
 * 1. Brave's Search API, when BRAVE_SEARCH_API_KEY is set. A real search API:
 *    fast, rate-limited by the key rather than by a bot check.
 * 2. A SearXNG instance at SEARXNG_URL, the self-hosted option, no key.
 * 3. Otherwise the app's own headless Chromium, on a search page. It needs no
 *    setting up at all, which is the point, but it is scraping: slower than an
 *    API, and it is the engine's markup that decides whether it keeps working.
 */

const DEFAULT_COUNT = 8
const MAX_COUNT = 20
const API_TIMEOUT_MS = 15_000
const PAGE_TIMEOUT_MS = 25_000
const MAX_SNIPPET = 300

export interface SearchHit {
  title: string
  url: string
  snippet: string
}

function env(name: string): string | null {
  const value = process.env[name]?.trim()
  return value !== undefined && value !== '' ? value : null
}

function braveKey(): string | null {
  return env('BRAVE_SEARCH_API_KEY') ?? env('BRAVE_API_KEY')
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= MAX_SNIPPET ? flat : `${flat.slice(0, MAX_SNIPPET)}…`
}

/** Drops the markup Brave and SearXNG put around the matched words. */
function plain(text: string): string {
  return clip(
    text
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  )
}

function usable(hit: SearchHit): boolean {
  return hit.title !== '' && (hit.url.startsWith('http://') || hit.url.startsWith('https://'))
}

/** Two engines can return the same page; the higher-ranked copy is kept. */
export function dedupe(hits: SearchHit[], count: number): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    if (!usable(hit)) continue
    const key = hit.url.replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
    if (out.length >= count) break
  }
  return out
}

function timeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

interface BravePayload {
  web?: { results?: { title?: string; url?: string; description?: string }[] }
}

export function parseBrave(payload: unknown): SearchHit[] {
  const results = (payload as BravePayload).web?.results ?? []
  return results.map((entry) => ({
    title: plain(entry.title ?? ''),
    url: entry.url ?? '',
    snippet: plain(entry.description ?? '')
  }))
}

async function searchBrave(
  query: string,
  count: number,
  key: string,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(count, MAX_COUNT)))
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    signal: timeout(signal, API_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new ToolError(
      response.status === 401 || response.status === 403
        ? 'Brave Search refused the key in BRAVE_SEARCH_API_KEY.'
        : `Brave Search failed with HTTP ${response.status}.`
    )
  }
  return parseBrave(await response.json())
}

interface SearxPayload {
  results?: { title?: string; url?: string; content?: string }[]
}

export function parseSearx(payload: unknown): SearchHit[] {
  const results = (payload as SearxPayload).results ?? []
  return results.map((entry) => ({
    title: plain(entry.title ?? ''),
    url: entry.url ?? '',
    snippet: plain(entry.content ?? '')
  }))
}

async function searchSearx(
  query: string,
  base: string,
  signal: AbortSignal
): Promise<SearchHit[]> {
  const url = new URL('/search', base.endsWith('/') ? base : `${base}/`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: timeout(signal, API_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new ToolError(
      `The SearXNG instance at ${base} answered HTTP ${response.status}. ` +
        'Its JSON format has to be enabled in settings.yml (search.formats: [html, json]).'
    )
  }
  return parseSearx(await response.json())
}

/**
 * Pulled out of the page so it can be exercised against a fixture. Runs inside
 * the browser, so it may use nothing from this module.
 */
const EXTRACT = `[...document.querySelectorAll('#b_results > li.b_algo')].map((row) => {
  const link = row.querySelector('h2 a')
  const snippet = row.querySelector('.b_caption p, .b_algoSlug, .b_lineclamp2, p')
  return {
    title: (link && link.textContent) || '',
    href: (link && link.getAttribute('href')) || '',
    snippet: (snippet && snippet.textContent) || ''
  }
})`

/**
 * Results link through a redirector whose target is base64url in `u=a1…`.
 * A link that does not carry one is passed through as it is.
 */
export function unwrapRedirect(href: string, origin: string): string {
  try {
    const parsed = new URL(href, origin)
    const target = parsed.searchParams.get('u')
    if (target === null || !target.startsWith('a1')) return parsed.toString()
    const decoded = Buffer.from(target.slice(2), 'base64url').toString('utf8')
    return decoded.startsWith('http') ? decoded : parsed.toString()
  } catch {
    return href
  }
}

/** The zero-configuration path: a real browser on a real search page. */
export async function searchInBrowser(
  query: string,
  scope: string,
  signal: AbortSignal,
  endpoint: string
): Promise<SearchHit[]> {
  return withPage(async (page) => {
    const url = `${endpoint}${encodeURIComponent(query)}`
    signal.throwIfAborted()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS })
    const raw = (await page.evaluate(EXTRACT)) as { title: string; href: string; snippet: string }[]
    return raw.map((entry) => ({
      title: plain(entry.title),
      url: unwrapRedirect(entry.href, url),
      snippet: plain(entry.snippet)
    }))
  }, scope)
}

const BROWSER_ENDPOINT = 'https://www.bing.com/search?q='

export function render(hits: SearchHit[], query: string, via: string): string {
  const head = `${hits.length} result${hits.length === 1 ? '' : 's'} for "${query}" (via ${via})`
  const body = hits
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet === '' ? '' : `\n   ${hit.snippet}`}`)
    .join('\n')
  return `${head}\n\n${body}\n\nRead a result with fetch_url, or with browser_navigate when the page needs JavaScript.`
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web and get back ranked results with their titles, URLs and snippets. ' +
    'Use it whenever the answer depends on something current, external, or that you cannot ' +
    'recall exactly, documentation, releases, error messages, prices, news, anyone’s public ' +
    'facts, rather than guessing a URL. The snippets are a summary, not the page: read the ' +
    'result itself with fetch_url or browser_navigate before relying on its details.',
  // The fallback drives a browser page, which is shared state, so a search may
  // not run alongside the other tools of its turn.
  readOnly: false,
  risk: 'low',
  schema: z.object({
    query: z.string().min(1).max(400).describe('What to search for, in words or keywords'),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_COUNT)
      .default(DEFAULT_COUNT)
      .describe(`How many results to return (1-${MAX_COUNT})`)
  }),
  preview: async (input) => ({ kind: 'text', subject: 'web_search', detail: input.query }),
  execute: async (input, context) => {
    const query = input.query.trim()
    if (query === '') throw new ToolError('The query is empty.')

    const key = braveKey()
    const searx = env('SEARXNG_URL')
    const attempts: { via: string; run: () => Promise<SearchHit[]> }[] = []
    if (key !== null) {
      attempts.push({ via: 'Brave Search', run: () => searchBrave(query, input.count, key, context.signal) })
    }
    if (searx !== null) {
      attempts.push({ via: `SearXNG (${searx})`, run: () => searchSearx(query, searx, context.signal) })
    }
    attempts.push({
      via: 'the built-in browser',
      run: () => searchInBrowser(query, searchScope(context.sessionId), context.signal, BROWSER_ENDPOINT)
    })

    const failures: string[] = []
    for (const attempt of attempts) {
      context.signal.throwIfAborted()
      try {
        const hits = dedupe(await attempt.run(), input.count)
        if (hits.length > 0) return render(hits, query, attempt.via)
        failures.push(`${attempt.via}: no results`)
      } catch (error) {
        if (context.signal.aborted) throw error
        failures.push(`${attempt.via}: ${(error as Error).message}`)
      }
    }

    // Every backend came back empty. Say which ones were tried and what would
    // make the next search work, rather than letting the model read "no
    // results" as "this does not exist".
    throw new ToolError(
      `No results for "${query}". Tried: ${failures.join('; ')}. ` +
        'A search engine may be blocking the built-in browser; setting BRAVE_SEARCH_API_KEY ' +
        '(or SEARXNG_URL for a self-hosted instance) in the .env file makes searching reliable.'
    )
  }
})
