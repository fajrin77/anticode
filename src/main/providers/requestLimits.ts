/** Request size/concurrency errors are different from an exhausted account. */
export interface RequestLimit {
  kind: 'input' | 'output' | 'inflight'
  promptTokens?: number
  limitTokens?: number
}

export class InputRequestLimitError extends Error {
  readonly status = 402
  readonly scope = 'model'
  readonly requestLimit: RequestLimit
  constructor(promptTokens: number, limitTokens: number, readonly minimumRequest = false, readonly cached = false) {
    super(`This conversation sends ${promptTokens} prompt tokens, but this key permits ${limitTokens}. ${minimumRequest
      ? 'The current request, instructions and tools still exceed this allowance after safe reduction. Choose an enabled route with a larger request allowance; repeating Continue cannot enlarge this limit.'
      : 'Reduce the conversation context or choose a route with a larger request allowance.'} This is a request-size limit, not proof that all keys are exhausted.`)
    this.name = 'InputRequestLimitError'
    this.requestLimit = { kind: 'input', promptTokens, limitTokens }
  }
}

export function requestLimit(error: unknown): RequestLimit | null {
  const pending = [error]
  for (let depth = 0; depth < 16 && pending.length; depth++) {
    const current = pending.shift()
    if (!current || typeof current !== 'object') continue
    const record = current as { message?: unknown; cause?: unknown; error?: unknown; requestLimit?: RequestLimit }
    const limit = record.requestLimit
    if (limit?.kind === 'input' && Number.isFinite(limit.promptTokens) && Number.isFinite(limit.limitTokens) && limit.limitTokens! > 0) return { ...limit }
    const text = typeof record.message === 'string' ? record.message : ''
    const match = /prompt tokens limit exceeded:\s*(\d+)\s*>\s*(\d+)/i.exec(text) ?? /conversation sends (\d+) prompt tokens, but this key permits (\d+)/i.exec(text)
    if (match) return { kind: 'input', promptTokens: Number(match[1]), limitTokens: Number(match[2]) }
    if (/available credits.+in[- ]flight requests/i.test(text)) return { kind: 'inflight' }
    if (/can only afford\s+\d+/i.test(text) && /max_tokens|requested|request requires/i.test(text)) return { kind: 'output' }
    pending.push(record.error, record.cause)
  }
  return null
}
