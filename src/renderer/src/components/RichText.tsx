import { useState } from 'react'
import type { JSX, ReactNode } from 'react'

/**
 * A deliberately small markdown subset — fenced code, tables, headings, bullets,
 * numbered lists, quotes, rules and inline emphasis — covering what the models
 * actually emit. A full parser would be far more surface area than the output
 * warrants. The phone page (src/main/remote/public/index.html) carries the
 * same rules in plain DOM; the two should read alike.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g
  let cursor = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${index}`

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-text [box-decoration-break:clone]"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**')) {
      // A bold run may hold code of its own, as in **`vercel.json` (root)**.
      nodes.push(
        <strong key={key} className="font-semibold text-text">
          {inline(token.slice(2, -2), key)}
        </strong>
      )
    } else {
      // A markdown link reads as its label; where it points is on hover.
      const label = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      nodes.push(
        <span key={key} title={label?.[2]}>
          {inline(label?.[1] ?? token, key)}
        </span>
      )
    }

    cursor = match.index + token.length
    index += 1
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] text-faint transition-colors hover:text-brand"
    >
      {copied ? (
        'copied'
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
            <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v6a1.5 1.5 0 0 0 1.5 1.5h.5" />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}

/**
 * Text the model wrote to be used elsewhere — a prompt it drafted, a block of
 * code — set apart from its own prose: the same mono face the model name wears
 * in the composer, in a panel with a copy control at each end, so a long block
 * can be copied without scrolling back to find the button.
 */
function PromptBlock({ text, label }: { text: string; label: string }): JSX.Element {
  return (
    <div className="my-3">
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className="text-[11px] tracking-wide text-faint uppercase">{label}</span>
        <div className="flex-1" />
        <CopyButton text={text} label={`Copy this ${label.toLowerCase()}`} />
      </div>
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-text">
        {text}
      </pre>
      <div className="mt-1 flex px-1">
        <div className="flex-1" />
        <CopyButton text={text} label={`Copy this ${label.toLowerCase()}`} />
      </div>
    </div>
  )
}

function cells(row: string): string[] {
  return row
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isSeparator(row: string): boolean {
  return /^\|?[\s:-]*-[\s:|-]*\|?$/.test(row) && row.includes('-')
}

function Table({ rows, keyPrefix }: { rows: string[]; keyPrefix: string }): JSX.Element {
  const [header, , ...body] = rows
  return (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr>
            {cells(header ?? '').map((cell, index) => (
              <th
                key={index}
                className="border-b border-line px-3 py-1.5 text-left font-medium text-dim"
              >
                {inline(cell, `${keyPrefix}-h${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {cells(row).map((cell, index) => (
                <td key={index} className="border-b border-line-soft px-3 py-1.5 align-top">
                  {inline(cell, `${keyPrefix}-r${rowIndex}c${index}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RichText({ text }: { text: string }): JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  // What the last block was, so blank lines and headings space themselves once.
  let lastKind: 'start' | 'gap' | 'heading' | 'item' | 'text' | 'block' = 'start'
  const push = (node: ReactNode, kind: typeof lastKind): void => {
    blocks.push(node)
    lastKind = kind
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''
    const key = `b-${index}`

    if (line.trimStart().startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      const language = line.trim().slice(3).trim()
      push(
        <PromptBlock
          key={key}
          text={body.join('\n')}
          label={language === '' ? 'Code' : language}
        />,
        'block'
      )
      continue
    }

    // A prompt the model drafted for the user to take away: a whole paragraph
    // wrapped in quotes, rather than a quoted phrase inside a sentence.
    if (/^\s*["\u201c]/.test(line)) {
      const paragraph: string[] = []
      let scan = index
      while (scan < lines.length && (lines[scan] ?? '').trim() !== '') {
        paragraph.push(lines[scan] ?? '')
        scan += 1
      }
      const joined = paragraph.join('\n').trim()
      if (/["\u201d]$/.test(joined) && joined.length > 60) {
        index = scan
        push(
          <PromptBlock
            key={key}
            text={joined.replace(/^["\u201c]/, '').replace(/["\u201d]$/, '').trim()}
            label="Prompt"
          />,
          'block'
        )
        continue
      }
    }

    if (line.trimStart().startsWith('|') && isSeparator(lines[index + 1] ?? '')) {
      const rows: string[] = []
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('|')) {
        rows.push(lines[index] ?? '')
        index += 1
      }
      push(<Table key={key} rows={rows} keyPrefix={key} />, 'block')
      continue
    }

    index += 1

    // A blank line is a visible gap. One after a heading, a rule or another
    // gap adds nothing: the heading's own margin already spaces it.
    if (line.trim() === '') {
      if (lastKind !== 'start' && lastKind !== 'gap' && lastKind !== 'heading') {
        push(<div key={key} className="h-2.5" />, 'gap')
      }
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      push(<div key={key} className="my-4 border-t border-line" />, 'heading')
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min((heading[1] ?? '#').length, 3)
      const size = level === 1 ? 'text-[20px]' : level === 2 ? 'text-[17.5px]' : 'text-[15.5px]'
      const top = lastKind === 'start' ? 'mt-0.5' : lastKind === 'gap' ? 'mt-2' : 'mt-5'
      push(
        <div key={key} className={`${top} mb-2 ${size} leading-snug font-semibold text-text`}>
          {inline((heading[2] ?? '').replace(/^\*\*(.*)\*\*$/, '$1'), key)}
        </div>,
        'heading'
      )
      continue
    }

    // Bullets and numbered items hang from their marker, indented by how deep
    // the model nested them.
    const item = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      const depth = Math.min(Math.floor((item[1] ?? '').replace(/\t/g, '  ').length / 2), 4)
      let body = item[4] ?? ''
      // A checklist reads as one: a ticked item takes the green mark in place
      // of the bare glyph, whether the model wrote it as a trailing check or
      // as a markdown task box.
      const box = item[2] !== undefined ? /^\[([ xX])\]\s*/.exec(body) : null
      if (box !== null) body = body.slice(box[0].length)
      const trailing = /\s*[\u2713\u2714]\s*$/.exec(body)
      if (trailing !== null) body = body.slice(0, trailing.index)
      push(
        <div key={key} className="flex gap-2.5 py-[3px]" style={{ paddingLeft: 4 + depth * 20 }}>
          {box !== null ? (
            <span className="shrink-0">{box[1] === ' ' ? '\u2610' : '\u2705'}</span>
          ) : item[2] !== undefined ? (
            <span
              className={`mt-[0.68em] h-[5px] w-[5px] shrink-0 rounded-full ${
                depth === 0 ? 'bg-dim' : 'border border-faint'
              }`}
            />
          ) : (
            <span className="min-w-[1.3em] shrink-0 text-right text-dim tabular-nums">
              {item[3]}.
            </span>
          )}
          <span className="min-w-0 flex-1">
            {inline(body, key)}
            {trailing !== null && <span className="ml-1.5">✅</span>}
          </span>
        </div>,
        'item'
      )
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      push(
        <div key={key} className="my-0.5 border-l-2 border-line py-0.5 pl-3 text-dim">
          {inline(quote[1] ?? '', key)}
        </div>,
        'text'
      )
      continue
    }

    push(
      <div key={key} className="py-px">
        {inline(line, key)}
      </div>,
      'text'
    )
  }

  return <div>{blocks}</div>
}
