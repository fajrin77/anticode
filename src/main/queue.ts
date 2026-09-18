import { randomUUID } from 'node:crypto'
import type { AttachmentRef, QueuedPrompt } from '@shared/ipc'

/**
 * Prompts waiting for the session's run to finish, oldest first. Kept here,
 * not by a viewer, so a prompt queued on the phone is shown, and can be
 * taken out, on the desktop, and the next one starts with no screen open.
 */
interface Entry extends QueuedPrompt {
  /** Staged attachments; released when the entry is sent or dropped. */
  attachmentIds: string[]
}

const queues = new Map<string, Entry[]>()
let sink: ((sessionId: string, items: QueuedPrompt[]) => void) | null = null

/** Called once by ipc registration; tells every viewer when a queue changes. */
export function setQueueSink(next: (sessionId: string, items: QueuedPrompt[]) => void): void {
  sink = next
}

function announce(sessionId: string): void {
  sink?.(sessionId, listQueue(sessionId))
}

export function listQueue(sessionId: string): QueuedPrompt[] {
  return (queues.get(sessionId) ?? []).map(({ id, text, attachments, plan }) => ({ id, text, attachments, plan }))
}

export function enqueue(
  sessionId: string,
  text: string,
  attachmentIds: string[],
  attachments: AttachmentRef[],
  plan = false
): QueuedPrompt {
  const entry: Entry = { id: randomUUID(), text, attachments, attachmentIds, plan }
  queues.set(sessionId, [...(queues.get(sessionId) ?? []), entry])
  announce(sessionId)
  return { id: entry.id, text, attachments, plan }
}

/** The next prompt to send, taken off the queue. */
export function dequeue(sessionId: string): Entry | undefined {
  const [next, ...rest] = queues.get(sessionId) ?? []
  if (next === undefined) return undefined
  if (rest.length === 0) queues.delete(sessionId)
  else queues.set(sessionId, rest)
  announce(sessionId)
  return next
}

/** A prompt that could not start goes back where it was: first in line. */
export function requeue(sessionId: string, entry: Entry): void {
  queues.set(sessionId, [entry, ...(queues.get(sessionId) ?? [])])
  announce(sessionId)
}

export function removeQueued(sessionId: string, id: string): Entry | undefined {
  const entries = queues.get(sessionId) ?? []
  const found = entries.find((entry) => entry.id === id)
  if (found === undefined) return undefined
  const rest = entries.filter((entry) => entry !== found)
  if (rest.length === 0) queues.delete(sessionId)
  else queues.set(sessionId, rest)
  announce(sessionId)
  return found
}

/** The session is gone: its queue goes with it, entries handed back to release. */
export function clearQueue(sessionId: string): Entry[] {
  const entries = queues.get(sessionId) ?? []
  queues.delete(sessionId)
  if (entries.length > 0) announce(sessionId)
  return entries
}
