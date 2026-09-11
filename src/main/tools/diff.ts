import { createTwoFilesPatch } from 'diff'

const MAX_DIFF_CHARS = 12_000
/** What the transcript keeps of a change; it is saved with the session. */
export const TRANSCRIPT_DIFF_CHARS = 30_000

export function unifiedDiff(path: string, before: string, after: string, maxChars = MAX_DIFF_CHARS): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 })
  return patch.length > maxChars
    ? `${patch.slice(0, maxChars)}\n… diff dipotong`
    : patch
}
