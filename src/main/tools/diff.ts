import { createTwoFilesPatch } from 'diff'

const MAX_DIFF_CHARS = 12_000

export function unifiedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 })
  return patch.length > MAX_DIFF_CHARS
    ? `${patch.slice(0, MAX_DIFF_CHARS)}\n… diff dipotong`
    : patch
}
