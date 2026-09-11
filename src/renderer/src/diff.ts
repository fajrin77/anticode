/*
 * Reads the unified diffs the edit tools produce into lines with their old and
 * new line numbers, and pairs them up for a side-by-side view.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldNo: number | null
  newNo: number | null
}

export interface Hunk {
  /** What follows the second @@ — often the enclosing function. */
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: Hunk[]
  added: number
  removed: number
  /** The tool cut a long diff short; the view says so. */
  truncated: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let truncated = false
  for (const raw of patch.split('\n')) {
    const header = HUNK.exec(raw)
    if (header !== null) {
      oldNo = Number(header[1])
      newNo = Number(header[2])
      current = { header: (header[3] ?? '').trim(), oldStart: oldNo, newStart: newNo, lines: [] }
      hunks.push(current)
      continue
    }
    if (raw.startsWith('… diff dipotong')) { truncated = true; continue }
    if (current === null) continue
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ })
      added += 1
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null })
      removed += 1
    } else if (raw.startsWith(' ') || raw === '') {
      // A trailing empty line closes the patch; inside a hunk it is context.
      if (raw === '' && current.lines.length === 0) continue
      current.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  // The patch ends with a newline, which reads as one empty context line.
  for (const hunk of hunks) {
    const last = hunk.lines.at(-1)
    if (last?.kind === 'ctx' && last.text === '' && hunk === hunks.at(-1)) hunk.lines.pop()
  }
  return { hunks, added, removed, truncated }
}

export interface SplitRow {
  left: DiffLine | null
  right: DiffLine | null
}

/**
 * Side by side: context on both sides, and each run of removals lined up
 * against the additions that follow it, so a changed line sits beside its
 * replacement.
 */
export function splitRows(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DiffLine[] = []
  let adds: DiffLine[] = []
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    }
    dels = []
    adds = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'del') {
      if (adds.length > 0) flush()
      dels.push(line)
    } else if (line.kind === 'add') {
      adds.push(line)
    } else {
      flush()
      rows.push({ left: line, right: line })
    }
  }
  flush()
  return rows
}
