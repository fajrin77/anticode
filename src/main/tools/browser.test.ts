import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  browserClickTool,
  browserFillTool,
  browserGetTextTool,
  browserNavigateTool,
  browserScreenshotTool,
  fetchUrlTool,
  readNetworkRequestsTool
} from './browser'
import { closeBrowser } from '../browser'
import type { ToolContext } from './types'

const PAGE = `<!doctype html>
<html><body>
  <h1 id="judul">Halaman Uji</h1>
  <p class="isi">Baris pertama</p>
  <p class="isi">Baris kedua</p>
  <input id="nama" />
  <button id="tombol" onclick="document.getElementById('judul').textContent='Sudah diklik'">Klik</button>
  <script>fetch('/api/data').then(() => {})</script>
</body></html>`

let server: Server
let origin: string
const context: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal }

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await closeBrowser()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('fetch_url', () => {
  it('returns the raw body without running scripts', async () => {
    const output = (await fetchUrlTool.prepare({ url: origin }).execute(context)).text
    expect(output).toContain('HTTP 200')
    expect(output).toContain('<h1 id="judul">')
  })

  it('rejects a non-http scheme', () => {
    expect(() => fetchUrlTool.prepare({ url: 'file:///etc/passwd' })).toThrow(/Input tidak valid/)
  })
})

describe('browser tools', () => {
  it('refuses to read before anything is open', async () => {
    await expect(browserGetTextTool.prepare({}).execute(context)).rejects.toThrow(
      /Belum ada halaman/
    )
  })

  it('navigates and reports the title', async () => {
    const output = (await browserNavigateTool.prepare({ url: origin }).execute(context)).text
    expect(output).toContain('Judul: ')
    expect(output).toContain('HTTP 200')
  })

  it('extracts whole-page text', async () => {
    const output = (await browserGetTextTool.prepare({}).execute(context)).text
    expect(output).toContain('Halaman Uji')
    expect(output).toContain('Baris kedua')
  })

  it('extracts text for a selector', async () => {
    const output = (await browserGetTextTool.prepare({ selector: '.isi' }).execute(context)).text
    expect(output).toBe('Baris pertama\n---\nBaris kedua')
  })

  it('reports a selector that matches nothing', async () => {
    await expect(
      browserGetTextTool.prepare({ selector: '#tidak-ada' }).execute(context)
    ).rejects.toThrow(/Tidak ada elemen/)
  })

  it('records network requests made by the page', async () => {
    const output = (await readNetworkRequestsTool.prepare({ filter: '/api/' }).execute(context))
      .text
    expect(output).toContain('/api/data')
    expect(output).toContain('200')
  })

  it('fills an input', async () => {
    await browserFillTool.prepare({ selector: '#nama', value: 'Asani' }).execute(context)
    const value = (await browserGetTextTool.prepare({ selector: 'body' }).execute(context)).text
    expect(value).toContain('Halaman Uji')
  })

  it('clicks an element and the page reacts', async () => {
    await browserClickTool.prepare({ selector: '#tombol' }).execute(context)
    const output = (await browserGetTextTool.prepare({ selector: '#judul' }).execute(context)).text
    expect(output).toBe('Sudah diklik')
  })

  it('returns a screenshot as an image block', async () => {
    const output = await browserScreenshotTool.prepare({}).execute(context)
    expect(output.images).toHaveLength(1)
    expect(output.images[0]?.mediaType).toBe('image/jpeg')

    const decoded = Buffer.from(output.images[0]?.data ?? '', 'base64')
    const meta = await sharp(decoded).metadata()
    expect(meta.width).toBeGreaterThan(100)
  })

  it('treats interaction as medium risk and reading as low', () => {
    expect(browserNavigateTool.prepare({ url: origin }).risk).toBe('low')
    expect(browserClickTool.prepare({ selector: '#tombol' }).risk).toBe('medium')
    expect(browserFillTool.prepare({ selector: '#nama', value: 'x' }).risk).toBe('medium')
  })
})
