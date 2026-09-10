import { useState } from 'react'
import type { JSX, ReactNode } from 'react'

/**
 * A deliberately small markdown subset — fenced code, tables, headings, bullets,
 * quotes and inline emphasis — covering what the models actually emit. A full
 * parser would be far more surface area than the output warrants.
 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let cursor = 0
  let match: RegExpExecArray | null
  let index = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    const token = match[0]

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={`${keyPrefix}-${index}`}
          className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-text"
        >
          {token.slice(1, -1)}
        </code>
      )
    } else {
      nodes.push(
        <strong key={`${keyPrefix}-${index}`} className="font-semibold text-text">
          {token.slice(2, -2)}
        </strong>
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
      blocks.push(
        <PromptBlock
          key={key}
          text={body.join('\n')}
          label={language === '' ? 'Code' : language}
        />
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
        blocks.push(
          <PromptBlock
            key={key}
            text={joined.replace(/^["\u201c]/, '').replace(/["\u201d]$/, '').trim()}
            label="Prompt"
          />
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
      blocks.push(<Table key={key} rows={rows} keyPrefix={key} />)
      continue
    }

    index += 1

    if (line.trim() === '') {
      blocks.push(<div key={key} className="h-2" />)
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push(
        <div key={key} className="mt-3 mb-1 text-[16px] font-semibold text-text">
          {inline(heading[2] ?? '', key)}
        </div>
      )
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      // A checklist reads as one: a ticked item takes the green mark in place
      // of the bare glyph, whether the model wrote it as a trailing check or
      // as a markdown task box.
      const item = bullet[1] ?? ''
      const ticked = /^\[[xX]\]\s*/.exec(item)
      const trailing = /\s*[\u2713\u2714]\s*$/.exec(item)
      const body = ticked !== null ? item.slice(ticked[0].length) : item
      const text = trailing !== null ? body.slice(0, trailing.index) : body
      blocks.push(
        <div key={key} className="flex gap-2.5 py-0.5 pl-1">
          {ticked !== null ? (
            <span className="shrink-0">✅</span>
          ) : (
            <span className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-faint" />
          )}
          <span className="min-w-0">
            {inline(text, key)}
            {trailing !== null && <span className="ml-1.5">✅</span>}
          </span>
        </div>
      )
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      blocks.push(
        <div key={key} className="border-l-2 border-line py-0.5 pl-3 text-dim">
          {inline(quote[1] ?? '', key)}
        </div>
      )
      continue
    }

    blocks.push(
      <div key={key} className="py-0.5">
        {inline(line, key)}
      </div>
    )
  }

  return <div>{blocks}</div>
}
