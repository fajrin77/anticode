/** Request size/concurrency errors are different from an exhausted account. */
export interface RequestLimit {
  kind: 'input' | 'output' | 'inflight'
  promptTokens?: number
  limitTokens?: number
}

export function requestLimit(error: unknown): RequestLimit | null {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const record = current as { message?: unknown; cause?: unknown; error?: unknown }
    const text = typeof record.message === 'string' ? record.message : ''
    const match = /prompt tokens limit exceeded:\s*(\d+)\s*>\s*(\d+)/i.exec(text)
    if (match) return { kind: 'input', promptTokens: Number(match[1]), limitTokens: Number(match[2]) }
    if (/available credits.+in[- ]flight requests/i.test(text)) return { kind: 'inflight' }
    if (/can only afford\s+\d+/i.test(text) && /max_tokens|requested|request requires/i.test(text)) return { kind: 'output' }
    current = record.error ?? record.cause
  }
  return null
}
