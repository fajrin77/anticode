import { Fragment, useMemo } from 'react'
import type { JSX } from 'react'
import { parseUnifiedDiff, splitRows } from '../diff'
import type { DiffLine, Hunk } from '../diff'
import { highlightLines, languageOf } from '../highlight'
import type { Token, TokenKind } from '../highlight'
import { useSessionStore } from '../store/session'

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  keyword: 'text-syn-keyword',
  string: 'text-syn-string',
  number: 'text-syn-number',
  comment: 'text-faint italic',
  type: 'text-syn-type',
  call: 'text-syn-call',
  tag: 'text-syn-keyword'
}

const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-add/10',
  del: 'bg-del/10',
  ctx: ''
}

const SIGN: Record<DiffLine['kind'], JSX.Element> = {
  add: <span className="text-add">+</span>,
  del: <span className="text-del">−</span>,
  ctx: <span> </span>
}

/**
 * Tokens for every line of a hunk. Each side is read in file order, old is
 * context plus removals, new is context plus additions, so a comment or a
 * string that spans lines is coloured the way the file itself reads.
 */
function tokensOf(hunk: Hunk, language: string | null): Map<DiffLine, Token[]> {
  const before = hunk.lines.filter((line) => line.kind !== 'add')
  const after = hunk.lines.filter((line) => line.kind !== 'del')
  const map = new Map<DiffLine, Token[]>()
  highlightLines(before.map((line) => line.text), language).forEach((tokens, index) => {
    const line = before[index]
    if (line !== undefined && line.kind === 'del') map.set(line, tokens)
  })
  highlightLines(after.map((line) => line.text), language).forEach((tokens, index) => {
    const line = after[index]
    if (line !== undefined) map.set(line, tokens)
  })
  return map
}

function Code({ tokens }: { tokens: Token[] | undefined }): JSX.Element {
  if (tokens === undefined || tokens.length === 0) return <span> </span>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  )
}

const NUMBER_CELL = 'w-[1%] select-none px-2 text-right align-top tabular-nums text-faint/70'

/**
 * A file change as a reader wants it: line numbers, green and red rows,
 * syntax colour, and a choice of one column or old beside new. The choice is
 * remembered for every diff, in the transcript and in approvals alike.
 */
export function DiffView({ patch, path, maxHeight = 'max-h-96' }: { patch: string; path: string; maxHeight?: string }): JSX.Element {
  const layout = useSessionStore((state) => state.diffLayout)
  const setLayout = useSessionStore((state) => state.setDiffLayout)
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch])
  const language = languageOf(path)
  const tokens = useMemo(() => parsed.hunks.map((hunk) => tokensOf(hunk, language)), [parsed, language])

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface" data-diff-view>
      <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5 text-[12px]">
        <span className="min-w-0 flex-1 truncate font-mono text-dim">{path}</span>
        <span className="shrink-0 tabular-nums">
          <span className="text-add">+{parsed.added}</span> <span className="text-del">−{parsed.removed}</span>
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {(['unified', 'split'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLayout(option)}
              aria-pressed={layout === option}
              className={`rounded-md border px-2 py-0.5 text-[11.5px] transition-colors hover:text-brand ${
                layout === option ? 'glass-control text-text' : 'border-transparent text-faint'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className={`${maxHeight} overflow-auto`}>
        {parsed.hunks.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-faint">No line changes.</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
            <tbody>
              {parsed.hunks.map((hunk, hunkIndex) => {
                const hunkTokens = tokens[hunkIndex]
                return (
                  <Fragment key={hunkIndex}>
                    <tr>
                      <td colSpan={4} className="bg-raised/50 px-3 py-0.5 text-[11px] text-faint">
                        @@ −{hunk.oldStart} +{hunk.newStart}
                        {hunk.header !== '' ? ` · ${hunk.header}` : ''}
                      </td>
                    </tr>
                    {layout === 'unified'
                      ? hunk.lines.map((line, index) => (
                          <tr key={index} className={ROW_TONE[line.kind]}>
                            <td className={NUMBER_CELL}>{line.oldNo ?? ''}</td>
                            <td className={NUMBER_CELL}>{line.newNo ?? ''}</td>
                            <td className="w-[1%] select-none pr-1.5 align-top">{SIGN[line.kind]}</td>
                            <td className="pr-4 whitespace-pre text-text">
                              <Code tokens={hunkTokens?.get(line)} />
                            </td>
                          </tr>
                        ))
                      : splitRows(hunk).map((row, index) => (
                          <tr key={index}>
                            <td className={`${NUMBER_CELL} ${row.left !== null ? ROW_TONE[row.left.kind] : 'bg-raised/30'}`}>
                              {row.left?.oldNo ?? ''}
                            </td>
                            <td
                              className={`w-1/2 border-r border-line-soft pr-3 align-top break-all whitespace-pre-wrap text-text ${
                                row.left !== null ? ROW_TONE[row.left.kind] : 'bg-raised/30'
                              }`}
                            >
                              {row.left !== null && <Code tokens={hunkTokens?.get(row.left)} />}
                            </td>
                            <td className={`${NUMBER_CELL} ${row.right !== null ? ROW_TONE[row.right.kind] : 'bg-raised/30'}`}>
                              {row.right?.newNo ?? ''}
                            </td>
                            <td
                              className={`w-1/2 pr-3 align-top break-all whitespace-pre-wrap text-text ${
                                row.right !== null ? ROW_TONE[row.right.kind] : 'bg-raised/30'
                              }`}
                            >
                              {row.right !== null && <Code tokens={hunkTokens?.get(row.right)} />}
                            </td>
                          </tr>
                        ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
        {parsed.truncated && (
          <div className="border-t border-line-soft px-3 py-1.5 text-[11px] text-faint">
            The diff was cut short; open the file to see all of it.
          </div>
        )}
      </div>
    </div>
  )
}
