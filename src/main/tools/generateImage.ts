import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { defineTool, ToolError } from './types'
import { resolveInWorkspace } from './workspace'

const MAX_IMAGE_BYTES = 30 * 1024 * 1024

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Generate a new image from a detailed text prompt using the active provider image endpoint. ' +
    'The PNG is saved in the session workspace and returned as a preview/download card.',
  readOnly: false,
  risk: 'medium',
  schema: z.object({
    prompt: z.string().min(1).max(32_000).describe('Detailed visual description of the image to create'),
    output_path: z.string().regex(/\.png$/i, 'Output path must end in .png').describe('PNG path relative to the workspace root'),
    model: z.string().min(1).default('gpt-image-1').describe('Image model id supported by the active provider'),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
    quality: z.enum(['low', 'medium', 'high', 'auto']).default('auto')
  }),
  preview: async (input, context) => {
    resolveInWorkspace(context.workspaceRoot, input.output_path)
    return {
      kind: 'text',
      subject: input.output_path,
      detail: `Generate with ${input.model} · ${input.size} · ${input.quality}\n\n${input.prompt}`
    }
  },
  execute: async (input, context) => {
    if (context.generateImage === undefined) {
      throw new ToolError(
        'The active provider does not support image generation. Select an OpenAI or OpenAI-compatible provider with an image endpoint.'
      )
    }
    const target = resolveInWorkspace(context.workspaceRoot, input.output_path)
    let generated: Awaited<ReturnType<NonNullable<typeof context.generateImage>>>
    try {
      generated = await context.generateImage({ ...input, signal: context.signal })
    } catch (error) {
      throw new ToolError(`Failed to generate image: ${(error as Error).message}`)
    }
    const bytes = Buffer.from(generated.data, 'base64')
    if (bytes.length === 0) throw new ToolError('The image provider returned an empty image')
    if (bytes.length > MAX_IMAGE_BYTES) throw new ToolError('The generated image is larger than 30 MB')
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
    } catch (error) {
      throw new ToolError(`Failed to save ${input.output_path}: ${(error as Error).message}`)
    }
    return {
      text: [
        `Generated image: ${input.output_path} (${Math.ceil(bytes.length / 1024)} KB)`,
        ...(generated.revisedPrompt !== undefined ? [`Revised prompt: ${generated.revisedPrompt}`] : [])
      ].join('\n'),
      // The persisted file card is the user-facing preview. Re-sending the
      // bytes to the chat model would break text-only models after a successful
      // generation and charge vision tokens unnecessarily.
      images: []
    }
  }
})
