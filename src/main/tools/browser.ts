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
    message: 'Only http and https are supported'
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
    'Fetch the raw contents of a URL over plain HTTP, without running JavaScript. ' +
    'For pages that need JS rendering, use browser_navigate.',
  readOnly: true,
  risk: 'low',
  schema: z.object({ url: urlSchema.describe('An http or https URL') }),
  execute: async (input, context) => {
    let response: Response
    try {
      response = await fetch(input.url, { signal: AbortSignal.any([context.signal, AbortSignal.timeout(DEFAULT_TIMEOUT)]), redirect: 'follow' })
    } catch (error) {
      throw new ToolError(`Failed to fetch ${input.url}: ${describe(error)}`)
    }
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let body = ''
    try {
      while (reader && body.length <= MAX_TEXT) {
        const part = await reader.read()
        if (part.done) break
        body += decoder.decode(part.value, { stream: true }).slice(0, MAX_TEXT + 1 - body.length)
      }
    } finally { await reader?.cancel() }
    return `HTTP ${response.status} ${response.headers.get('content-type') ?? ''}\n\n${clip(body)}`
  }
})

export const browserNavigateTool = defineTool({
  name: 'browser_navigate',
  description:
    'Open a URL in the headless browser and wait for the page to finish loading, including JavaScript. ' +
    'The page stays open for the following browser tools.',
  // All browser tools share one page, so they must not run concurrently; only
  // fetch_url is genuinely parallel-safe.
  readOnly: false,
  risk: 'low',
  schema: z.object({
    url: urlSchema.describe('An http or https URL'),
    wait_for: z
      .enum(['load', 'domcontentloaded', 'networkidle'])
      .default('load')
      .describe('Wait condition before the page counts as loaded')
  }),
  execute: async (input, context) =>
    withPage(async (page) => {
      clearNetworkRecords(context.sessionId)
      try {
        const response = await page.goto(input.url, {
          waitUntil: input.wait_for,
          timeout: DEFAULT_TIMEOUT
        })
        return `Opened: ${page.url()} (HTTP ${response?.status() ?? 'unknown'})\nTitle: ${await page.title()}`
      } catch (error) {
        throw new ToolError(`Failed to open ${input.url}: ${describe(error)}`)
      }
    }, context.sessionId)
})

export const browserGetTextTool = defineTool({
  name: 'browser_get_text',
  description:
    'Read text from the currently open page. Without a selector, the whole body is returned.',
  readOnly: false,
  risk: 'low',
  schema: z.object({
    selector: z.string().optional().describe('CSS selector; leave empty for the whole page')
  }),
  execute: async (input, context) => {
    const page = requirePage(context.sessionId)
    try {
      if (input.selector === undefined) {
        return clip(await page.innerText('body'))
      }
      const locator = page.locator(input.selector)
      if ((await locator.count()) === 0) {
        throw new ToolError(`No element matches "${input.selector}"`)
      }
      return clip((await locator.allInnerTexts()).join('\n---\n'))
    } catch (error) {
      if (error instanceof ToolError) throw error
      throw new ToolError(`Failed to read text: ${describe(error)}`)
    }
  }
})

export const browserScreenshotTool = defineTool({
  name: 'browser_screenshot',
  description:
    'Capture a screenshot of the currently open page and send it as an image to look at.',
  readOnly: false,
  risk: 'low',
  schema: z.object({
    full_page: z.boolean().default(false).describe('True to capture the full page height')
  }),
  execute: async (input, context) => {
    const page = requirePage(context.sessionId)
    let raw: Buffer
    try {
      raw = await page.screenshot({ fullPage: input.full_page, type: 'png' })
    } catch (error) {
      throw new ToolError(`Failed to capture screenshot: ${describe(error)}`)
    }

    const resized = await sharp(raw)
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer()

    return {
      text: `Screenshot of ${page.url()} attached.`,
      images: [{ mediaType: 'image/jpeg', data: resized.toString('base64') }]
    }
  }
})

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: 'Click the first element matching the selector on the currently open page.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({ selector: z.string().min(1).describe('CSS selector of the element to click') }),
  preview: async (input, context) => ({
    kind: 'command',
    subject: requirePage(context.sessionId).url(),
    detail: `Click element: ${input.selector}`
  }),
  execute: async (input, context) => {
    const page = requirePage(context.sessionId)
    try {
      await page.locator(input.selector).first().click({ timeout: DEFAULT_TIMEOUT })
    } catch (error) {
      throw new ToolError(`Failed to click "${input.selector}": ${describe(error)}`)
    }
    return `Clicked: ${input.selector}\nURL now: ${page.url()}`
  }
})

export const browserFillTool = defineTool({
  name: 'browser_fill',
  description: 'Fill an input or textarea on the currently open page.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    selector: z.string().min(1).describe('CSS selector of the input element'),
    value: z.string().describe('The value to type in')
  }),
  preview: async (input, context) => ({
    kind: 'command',
    subject: requirePage(context.sessionId).url(),
    detail: `Fill ${input.selector} with:\n${input.value}`
  }),
  execute: async (input, context) => {
    const page = requirePage(context.sessionId)
    try {
      await page.locator(input.selector).first().fill(input.value, { timeout: DEFAULT_TIMEOUT })
    } catch (error) {
      throw new ToolError(`Failed to fill "${input.selector}": ${describe(error)}`)
    }
    return `Filled: ${input.selector}`
  }
})

export const readNetworkRequestsTool = defineTool({
  name: 'read_network_requests',
  description:
    'List the network requests recorded since the last navigation, useful for inspecting ' +
    'the backend endpoints the page calls.',
  readOnly: false,
  risk: 'low',
  schema: z.object({
    filter: z.string().optional().describe('Only show URLs containing this text')
  }),
  execute: async (input, context) => {
    const matched = networkRecords(context.sessionId).filter(
      (record) => input.filter === undefined || record.url.includes(input.filter)
    )
    if (matched.length === 0) return '(no requests recorded)'

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
