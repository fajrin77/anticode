import sharp from 'sharp'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { clearNetworkRecords, networkRecords, requirePage, withPage } from '../browser'

const MAX_TEXT = 20_000
const MAX_IMAGE_EDGE = 1568
const DEFAULT_TIMEOUT = 30_000

const urlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'Hanya http dan https yang didukung'
  })

function clip(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n… dipotong (${text.length} karakter total)`
    : text
}

function describe(error: unknown): string {
  return (error as Error).message
}

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description:
    'Ambil isi mentah sebuah URL lewat HTTP biasa, tanpa menjalankan JavaScript. ' +
    'Untuk halaman yang butuh render JS, pakai browser_navigate.',
  readOnly: true,
  risk: 'low',
  schema: z.object({ url: urlSchema.describe('URL http atau https') }),
  execute: async (input, context) => {
    let response: Response
    try {
      response = await fetch(input.url, { signal: context.signal, redirect: 'follow' })
    } catch (error) {
      throw new ToolError(`Gagal mengambil ${input.url}: ${describe(error)}`)
    }
    const body = await response.text()
    return `HTTP ${response.status} ${response.headers.get('content-type') ?? ''}\n\n${clip(body)}`
  }
})

export const browserNavigateTool = defineTool({
  name: 'browser_navigate',
  description:
    'Buka URL di browser headless dan tunggu halaman selesai dimuat, termasuk JavaScript. ' +
    'Halaman ini tetap terbuka untuk tool browser berikutnya.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    url: urlSchema.describe('URL http atau https'),
    wait_for: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .default('load')
      .describe('Kondisi tunggu sebelum dianggap selesai')
  }),
  execute: async (input) =>
    withPage(async (page) => {
      clearNetworkRecords()
      try {
        const response = await page.goto(input.url, {
          waitUntil: input.wait_for,
          timeout: DEFAULT_TIMEOUT
        })
        return `Terbuka: ${page.url()} (HTTP ${response?.status() ?? 'tidak diketahui'})\nJudul: ${await page.title()}`
      } catch (error) {
        throw new ToolError(`Gagal membuka ${input.url}: ${describe(error)}`)
      }
    })
})

export const browserGetTextTool = defineTool({
  name: 'browser_get_text',
  description:
    'Ambil teks dari halaman yang sedang terbuka. Tanpa selector, seluruh isi body yang diambil.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    selector: z.string().optional().describe('Selector CSS; kosongkan untuk seluruh halaman')
  }),
  execute: async (input) => {
    const page = requirePage()
    try {
      if (input.selector === undefined) {
        return clip(await page.innerText('body'))
      }
      const locator = page.locator(input.selector)
      if ((await locator.count()) === 0) {
        throw new ToolError(`Tidak ada elemen yang cocok dengan "${input.selector}"`)
      }
      return clip((await locator.allInnerTexts()).join('\n---\n'))
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Gagal membaca teks: ${describe(error)}`)
    }
  }
})

export const browserScreenshotTool = defineTool({
  name: 'browser_screenshot',
  description:
    'Ambil tangkapan layar halaman yang sedang terbuka dan kirimkan sebagai gambar untuk dilihat.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    full_page: z.boolean().default(false).describe('True untuk menangkap seluruh tinggi halaman')
  }),
  execute: async (input) => {
    const page = requirePage()
    let raw: Buffer
    try {
      raw = await page.screenshot({ fullPage: input.full_page, type: 'png' })
    } catch (error) {
      throw new ToolError(`Gagal mengambil tangkapan layar: ${describe(error)}`)
    }

    const resized = await sharp(raw)
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()

    return {
      text: `Tangkapan layar ${page.url()} terlampir.`,
      images: [{ mediaType: 'image/jpeg', data: resized.toString('base64') }]
    }
  }
})

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: 'Klik elemen pertama yang cocok dengan selector di halaman yang sedang terbuka.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({ selector: z.string().min(1).describe('Selector CSS elemen yang diklik') }),
  preview: async (input) => ({
    kind: 'command',
    subject: requirePage().url(),
    detail: `Klik elemen: ${input.selector}`
  }),
  execute: async (input) => {
    const page = requirePage()
    try {
      await page.locator(input.selector).first().click({ timeout: DEFAULT_TIMEOUT })
    } catch (error) {
      throw new ToolError(`Gagal mengklik "${input.selector}": ${describe(error)}`)
    }
    return `Diklik: ${input.selector}\nURL sekarang: ${page.url()}`
  }
})

export const browserFillTool = defineTool({
  name: 'browser_fill',
  description: 'Isi sebuah input atau textarea di halaman yang sedang terbuka.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    selector: z.string().min(1).describe('Selector CSS elemen input'),
    value: z.string().describe('Nilai yang diisikan')
  }),
  preview: async (input) => ({
    kind: 'command',
    subject: requirePage().url(),
    detail: `Isi ${input.selector} dengan:\n${input.value}`
  }),
  execute: async (input) => {
    const page = requirePage()
    try {
      await page.locator(input.selector).first().fill(input.value, { timeout: DEFAULT_TIMEOUT })
    } catch (error) {
      throw new ToolError(`Gagal mengisi "${input.selector}": ${describe(error)}`)
    }
    return `Terisi: ${input.selector}`
  }
})

export const readNetworkRequestsTool = defineTool({
  name: 'read_network_requests',
  description:
    'Daftar request jaringan yang tercatat sejak navigasi terakhir, berguna untuk memeriksa ' +
    'endpoint backend yang dipanggil halaman.',
  readOnly: true,
  risk: 'low',
  schema: z.object({
    filter: z.string().optional().describe('Hanya tampilkan URL yang memuat teks ini')
  }),
  execute: async (input) => {
    const matched = networkRecords().filter(
      (record) => input.filter === undefined || record.url.includes(input.filter)
    )
    if (matched.length === 0) return '(tidak ada request tercatat)'

    return matched
      .map(
        (record) =>
          `${record.method} ${record.status ?? '…'} ${record.url}${
            record.contentType !== null ? ` [${record.contentType.split(';')[0]}]` : ''
          }`
      )
      .join('\n')
  }
})
