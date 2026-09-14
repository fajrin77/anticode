import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import sharp from 'sharp'
import { defineTool, ToolError } from './types'

/** Vision models want bounded images: 1568 px is the long edge Claude handles 1:1. */
const MAX_IMAGE_EDGE = 1568
/** The capture lives just long enough to be read and resized. */
const SCREENSHOT_TIMEOUT_MS = 10_000

export const screenshotTool = defineTool({
  name: 'screenshot',
  description:
    'Capture the full macOS screen and send it as an image to look at. ' +
    'Requires Screen Recording permission for anticode (or the terminal launching a development build); ' +
    'macOS shows a prompt the first time.',
  /**
   * A screenshot copies private pixels — mail, messages, passwords — off the
   * screen and into the model's context. It is bounded like a browser
   * screenshot, but what it reads is the user's whole display, so it asks.
   */
  readOnly: false,
  risk: 'medium',
  schema: z.object({}),
  preview: async () => ({
    kind: 'command',
    subject: 'macOS screen',
    detail: 'Capture a screenshot of the entire screen'
  }),
  execute: async (_input, context) => {
    void context
    if (process.platform !== 'darwin') {
      throw new ToolError('The screenshot tool is macOS-only in this build')
    }

    const directory = await mkdtemp(join(tmpdir(), 'anticode-shot-'))
    const target = join(directory, 'screen.png')
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          '/usr/sbin/screencapture',
          ['-x', target],
          { timeout: SCREENSHOT_TIMEOUT_MS },
          (error) => {
            if (error !== null) {
              reject(new ToolError(`screencapture failed: ${error.message ?? String(error)}. Check Screen Recording in System Settings → Privacy & Security, then retry. Screen capture reads the display; controlling other apps requires desktop-control tools.`))
              return
            }
            resolve()
          }
        )
      })

      const raw = await readFile(target)
      if (raw.byteLength === 0) {
        throw new ToolError(
          'screencapture produced an empty file — grant anticode Screen Recording ' +
            'permission in System Settings → Privacy & Security, then retry'
        )
      }

      const resized = await sharp(raw)
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()

      return {
        text: 'Screenshot of the whole screen attached.',
        images: [{ mediaType: 'image/jpeg', data: resized.toString('base64') }]
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
