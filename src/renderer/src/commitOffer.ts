import type { Message } from './store/session'

/** Only the current, finished answer may offer a repository action. */
export function commitOffer(messages: Message[]): string | null {
  const last = messages.at(-1)
  if (!last || last.role !== 'assistant' || last.pending || !last.summary) return null
  const text = last.parts.flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n')
  // A commit may already exist: a separate invitation to push still needs the actions.
  const offer = /\bcommit\b|(?:belum\s+push|(?:boleh|mau|ingin|lanjut|silakan|should I|shall I|would you like|can I)\b[^.!?\n]*\bpush\b)/i
  const pending = /(?:belum|ingin|mau|lanjut|boleh|silakan|should I|shall I|would you like|not yet|ready to|can I)/i
  return offer.test(text) && pending.test(text) ? last.id : null
}
