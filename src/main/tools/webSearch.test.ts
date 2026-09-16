import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  dedupe,
  parseBrave,
  parseSearx,
  render,
  searchInBrowser,
  unwrapRedirect,
  webSearchTool
} from './webSearch'
import { browserNavigateTool } from './browser'
import { closeBrowser, requirePage, searchScope } from '../browser'
import type { ToolContext } from './types'

/** A page shaped like a search engine's, so no test ever leaves the machine. */
const SERP = `<!doctype html><html><body><ol id="b_results">
  <li class="b_algo"><h2><a href="/go?u=a1aHR0cHM6Ly92aXRlLmRldi9ndWlkZS8=">Getting Started | Vite</a></h2>
    <div class="b_caption"><p>Vite is a build tool that aims to provide a faster experience.</p></div></li>
  <li class="b_algo"><h2><a href="https://vite.dev/guide/">Getting Started | Vite</a></h2>
    <div class="b_caption"><p>The same page again, linked directly.</p></div></li>
  <li class="b_algo"><h2><a href="https://example.test/two">Kedua</a></h2>
    <div class="b_caption"><p>Hasil <strong>kedua</strong> dengan markup.</p></div></li>
  <li class="b_algo"><h2><a href="https://example.test/three">Ketiga</a></h2></li>
</ol></body></html>`

const AGENT_PAGE = '<!doctype html><html><body><h1>Halaman Agen</h1></body></html>'

let server: Server
let origin: string
const context: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal }

beforeAll(async () => {
  server = createServer((req, res) => {
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end((req.url ?? '').startsWith('/serp') ? SERP : AGENT_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await closeBrowser()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

it('reads Brave results and strips the markup around the matched words', () => {
  const hits = parseBrave({
    web: {
      results: [
        { title: 'Vite', url: 'https://vite.dev', description: 'A <strong>build</strong> tool &amp; dev server' },
        { title: 'No URL', description: 'dropped later' }
      ]
    }
  })
  expect(hits[0]).toEqual({ title: 'Vite', url: 'https://vite.dev', snippet: 'A build tool & dev server' })
  expect(dedupe(hits, 5)).toHaveLength(1)
})

it('reads SearXNG results, whose snippet lives under another name', () => {
  const hits = parseSearx({ results: [{ title: 'Judul', url: 'https://a.test', content: 'Isi  ringkas' }] })
  expect(hits).toEqual([{ title: 'Judul', url: 'https://a.test', snippet: 'Isi ringkas' }])
  expect(parseSearx({})).toEqual([])
})

it('decodes the redirector a result is linked through', () => {
  const wrapped = '/go?u=a1aHR0cHM6Ly92aXRlLmRldi9ndWlkZS8='
  expect(unwrapRedirect(wrapped, 'https://engine.test/search?q=x')).toBe('https://vite.dev/guide/')
  // A direct link, and a `u` that is not one of ours, are left alone.
  expect(unwrapRedirect('https://vite.dev/guide/', 'https://engine.test/')).toBe('https://vite.dev/guide/')
  expect(unwrapRedirect('https://engine.test/go?u=zzz', 'https://engine.test/')).toBe(
    'https://engine.test/go?u=zzz'
  )
})

it('keeps the higher-ranked copy when the same page comes back twice', () => {
  const hits = dedupe(
    [
      { title: 'Satu', url: 'https://vite.dev/guide/', snippet: 'a' },
      { title: 'Satu lagi', url: 'https://www.vite.dev/guide', snippet: 'b' },
      { title: 'Dua', url: 'https://example.test/two', snippet: 'c' },
      { title: 'Bukan http', url: 'javascript:alert(1)', snippet: 'd' }
    ],
    10
  )
  expect(hits.map((hit) => hit.title)).toEqual(['Satu', 'Dua'])
})

it('numbers the results and says how to read one', () => {
  const text = render([{ title: 'Vite', url: 'https://vite.dev', snippet: 'Tooling' }], 'vite', 'Brave Search')
  expect(text).toContain('1 result for "vite" (via Brave Search)')
  expect(text).toContain('1. Vite\n   https://vite.dev\n   Tooling')
  expect(text).toContain('fetch_url')
})

it('scrapes a results page and leaves the page the agent is reading alone', async () => {
  const session = { ...context, sessionId: 'sesi' }
  // The agent opens a page of its own first; a search must not navigate it.
  await browserNavigateTool.prepare({ url: `${origin}/halaman` }).execute(session)

  const hits = await searchInBrowser('vite', searchScope('sesi'), session.signal, `${origin}/serp?q=`)
  expect(hits[0]?.url).toBe('https://vite.dev/guide/')
  expect(hits[0]?.snippet).toBe('Vite is a build tool that aims to provide a faster experience.')
  // A result without a snippet still counts; one without a link would not.
  expect(hits).toHaveLength(4)
  expect(hits[3]).toEqual({ title: 'Ketiga', url: 'https://example.test/three', snippet: '' })

  expect(requirePage('sesi').url()).toBe(`${origin}/halaman`)
}, 60_000)

it('refuses a query that is only whitespace before any engine is asked', async () => {
  await expect(webSearchTool.prepare({ query: '   ' }).execute(context)).rejects.toThrow(/empty/)
  expect(() => webSearchTool.prepare({ query: '' })).toThrow(/Invalid input/)
  expect(() => webSearchTool.prepare({ query: 'vite', count: 99 })).toThrow(/Invalid input/)
})

it('asks for how many results the model wanted, and no more', () => {
  const many = Array.from({ length: 12 }, (_, index) => ({
    title: `Hasil ${index}`,
    url: `https://example.test/${index}`,
    snippet: ''
  }))
  expect(dedupe(many, 3)).toHaveLength(3)
})
