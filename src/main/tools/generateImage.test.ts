import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { generateImageTool } from './generateImage'
import type { ToolContext } from './types'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-image-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('generates an image into the session workspace', async () => {
  const bytes = Buffer.from('generated png fixture')
  let received: Record<string, unknown> | null = null
  const context: ToolContext = {
    workspaceRoot: root,
    signal: new AbortController().signal,
    generateImage: async (input) => {
      received = input
      return { mediaType: 'image/png', data: bytes.toString('base64'), revisedPrompt: 'revised' }
    }
  }
  const output = await generateImageTool.prepare({
    prompt: 'A quiet mountain lake',
    output_path: 'images/lake.png'
  }).execute(context)

  expect(received).toMatchObject({
    prompt: 'A quiet mountain lake',
    model: 'gpt-image-1',
    size: '1024x1024',
    quality: 'auto'
  })
  expect(await readFile(path.join(root, 'images/lake.png'))).toEqual(bytes)
  expect(output.text).toContain('Generated image: images/lake.png')
  expect(output.text).toContain('Revised prompt: revised')
})

it('requires an image-capable provider and keeps paths inside the workspace', async () => {
  const context: ToolContext = { workspaceRoot: root, signal: new AbortController().signal }
  await expect(generateImageTool.prepare({ prompt: 'x', output_path: 'x.png' }).execute(context))
    .rejects.toThrow(/does not support image generation/)
  await expect(generateImageTool.prepare({ prompt: 'x', output_path: '../x.png' }).preview(context))
    .rejects.toThrow(/outside the workspace/)
})
