import { createTwoFilesPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, splitRows } from './diff'
import { highlightLines, languageOf } from './highlight'

const patch = createTwoFilesPatch('a/x.ts', 'b/x.ts', 'one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nfour\nfive\n', '', '', { context: 3 })

describe('parseUnifiedDiff', () => {
  it('numbers old and new lines and counts the change', () => {
    const parsed = parseUnifiedDiff(patch)
    expect(parsed.added).toBe(2)
    expect(parsed.removed).toBe(1)
    const lines = parsed.hunks[0]?.lines ?? []
    expect(lines.map((line) => [line.kind, line.text, line.oldNo, line.newNo])).toEqual([
      ['ctx', 'one', 1, 1],
      ['del', 'two', 2, null],
      ['add', 'TWO', null, 2],
      ['ctx', 'three', 3, 3],
      ['ctx', 'four', 4, 4],
      ['add', 'five', null, 5]
    ])
  })

  it('notices a diff the tool cut short', () => {
    expect(parseUnifiedDiff(`${patch}\n… diff dipotong`).truncated).toBe(true)
  })

  it('pairs a removal with the addition that replaces it', () => {
    const rows = splitRows(parseUnifiedDiff(patch).hunks[0]!)
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ['one', 'one'],
      ['two', 'TWO'],
      ['three', 'three'],
      ['four', 'four'],
      [null, 'five']
    ])
  })
})

describe('highlightLines', () => {
  it('knows keywords, strings, numbers, calls, and comments', () => {
    const [line] = highlightLines(["const total = sum('a', 42) // why"], languageOf('src/app.ts'))
    expect(line?.filter((token) => token.kind !== 'plain')).toEqual([
      { kind: 'keyword', text: 'const' },
      { kind: 'call', text: 'sum' },
      { kind: 'string', text: "'a'" },
      { kind: 'number', text: '42' },
      { kind: 'comment', text: '// why' }
    ])
  })

  it('carries a block comment and a template string across lines', () => {
    const lines = highlightLines(['/* start', 'still comment */ let x = `a', 'b` + 1'], 'js')
    expect(lines[1]?.[0]).toEqual({ kind: 'comment', text: 'still comment */' })
    expect(lines[2]?.[0]).toEqual({ kind: 'string', text: 'b`' })
  })

  it('leaves unknown files as plain text', () => {
    expect(languageOf('notes.unknownext')).toBeNull()
    expect(highlightLines(['anything'], null)).toEqual([[{ kind: 'plain', text: 'anything' }]])
  })
})
