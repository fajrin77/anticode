/** Raw model control tokens are not executable tool calls. Never echo their payload. */
export class ToolMarkupError extends Error {
  constructor() {
    super('Model mengirim format tool yang tidak valid. Perintah dari teks tersebut tidak dijalankan. Pilih model lain atau coba kembali.')
    this.name = 'ToolMarkupError'
  }
}

interface FilteredText {
  text: string
  rejected: boolean
}

/**
 * Hold only a possible DSML opening token, including across stream chunks.
 * Backtick-quoted examples remain ordinary text. The command body is never
 * parsed, logged or executed; the caller requests native tool calls instead.
 */
export class ToolMarkupGuard {
  private held = ''
  private ticks = 0
  private codeTicks = 0
  private rejected = false

  push(delta: string): FilteredText {
    if (this.rejected) return { text: '', rejected: true }
    let text = ''
    for (const char of delta) {
      if (this.held !== '') {
        this.held += char
        const token = this.held.replace(/\s/g, '').replace(/｜/g, '|').toUpperCase()
        if (token === '<|DSML|' || this.held.length > 256) {
          this.rejected = true
          this.held = ''
          return { text, rejected: true }
        }
        if ('<|DSML|'.startsWith(token)) continue
        // It was HTML, math or other ordinary prose. Reprocess the last
        // character so a new '<' or a backtick still starts its own token.
        text += this.held.slice(0, -1)
        this.held = ''
      }
      if (char === '`') {
        this.ticks++
        text += char
        continue
      }
      if (this.ticks > 0) {
        if (this.codeTicks === 0) this.codeTicks = this.ticks
        else if (this.codeTicks === this.ticks) this.codeTicks = 0
        this.ticks = 0
      }
      if (char === '<' && this.codeTicks === 0) this.held = char
      else text += char
    }
    return { text, rejected: false }
  }

  finish(): FilteredText {
    const token = this.held.replace(/\s/g, '').replace(/｜/g, '|').toUpperCase()
    this.rejected ||= token.startsWith('<|D')
    const text = this.rejected ? '' : this.held
    this.held = ''
    return { text, rejected: this.rejected }
  }
}
