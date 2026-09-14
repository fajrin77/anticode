import { describe, expect, it } from 'vitest'
import { screenshotTool } from './screenshot'

/** The registry hands runs a prepared call: risk first, execute behind it. */
function prepared(input: Record<string, unknown> = {}): ReturnType<typeof screenshotTool.prepare> {
  return screenshotTool.prepare(input)
}

const context = { sessionId: 's1', signal: new AbortController().signal } as never

describe('screenshot tool', () => {
  it('is a mutating tool whose prepared call carries a medium risk', () => {
    expect(screenshotTool.name).toBe('screenshot')
    expect(screenshotTool.readOnly).toBe(false)
    expect(prepared().risk).toBe('medium')
  })

  it('its preview names the screen, so the approval dialog is honest', async () => {
    const preview = await prepared().preview(context)
    expect(preview.kind).toBe('command')
    expect(preview.subject).toMatch(/screen/i)
  })

  it('is macOS-only: other platforms fail with a clear message', async () => {
    if (process.platform === 'darwin') return
    await expect(prepared().execute(context)).rejects.toThrow(/macOS-only/)
  })

  it('on macOS, the capture either succeeds as an image or explains the permission', async () => {
    if (process.platform !== 'darwin') return
    try {
      const result = await prepared().execute(context)
      expect(result.images).toHaveLength(1)
      expect(result.images[0]!.mediaType).toBe('image/jpeg')
      expect(result.images[0]!.data.length).toBeGreaterThan(1000)
    } catch (error) {
      expect((error as Error).message).toMatch(/screencapture|Screen Recording/)
    }
  })
})
