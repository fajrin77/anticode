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
          className="rounded bg-raised px-1.5 py-0.5 font-mono text-[0.86em] text-code"
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
      blocks.push(
        <pre
          key={key}
          className="my-2 overflow-x-auto rounded-lg border border-line bg-surface px-4 py-3 font-mono text-[12.5px] leading-relaxed text-dim"
        >
          {body.join('\n')}
        </pre>
      )
      continue
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
      blocks.push(
        <div key={key} className="flex gap-2.5 py-0.5 pl-1">
          <span className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-faint" />
          <span className="min-w-0">{inline(bullet[1] ?? '', key)}</span>
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
