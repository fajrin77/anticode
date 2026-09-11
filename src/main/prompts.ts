import type { AgentEvent, AgentRequest, AttachmentRef, ProviderSelection } from '@shared/ipc'
import { ROTATE_PROVIDER } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import type { ContentBlock } from './providers/types'
import { attachmentsFor, blocksOf, refsOf, releaseAttachments, stagedRefs } from './attachments/registry'
import { randomUUID } from 'node:crypto'
import { clearQueue, dequeue, enqueue, removeQueued, requeue } from './queue'
import type { QueuedPrompt } from '@shared/ipc'
import { announceTitle, getSession, getStatus, persistSessions, selectProvider, takeBackPrompt } from './runtime'
import { beginRun, finishRun, runForSession } from './runs'
import { announceHistory, announceStatus, forward, registerRun } from './remote/bus'

/** A turn that is sent again as it was: its blocks are already built. */
interface Prepared {
  blocks: ContentBlock[]
  attachments: AttachmentRef[]
}

// Serialize admission, including attachment preparation, across both transports.
// The queue releases as soon as the run starts, so follow-ups still join it.
const admissions = new Map<string, Promise<unknown>>()

export function submitPrompt(
  req: AgentRequest,
  gate: ApprovalGate,
  prepared?: Prepared
): Promise<{ runId: string; steered: boolean }> {
  const previous = admissions.get(req.sessionId) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(() => admit(req, gate, prepared))
  admissions.set(req.sessionId, pending)
  void pending.finally(() => {
    if (admissions.get(req.sessionId) === pending) admissions.delete(req.sessionId)
  }).catch(() => undefined)
  return pending
}

async function admit(
  req: AgentRequest,
  gate: ApprovalGate,
  prepared?: Prepared
): Promise<{ runId: string; steered: boolean }> {
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 200_000) {
    throw new Error('Enter a prompt of at most 200,000 characters')
  }
  if (!Array.isArray(req.attachmentIds) || req.attachmentIds.some((id) => typeof id !== 'string')) {
    throw new Error('Invalid attachment IDs')
  }
  const sent = prepared === undefined ? await attachmentsFor(req.sessionId, req.attachmentIds) : []
  const blocks = prepared?.blocks ?? (await blocksOf(req.sessionId, sent))
  const refs = prepared?.attachments ?? refsOf(sent)
  // Preparation can outlive a deletion, model change, or a finishing run.
  // Recheck the current main-process state after that asynchronous work —
  // this session's own model, not whichever was picked last elsewhere.
  const status = getStatus(req.sessionId)
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'Agent is not ready')
  const agent = getSession(req.sessionId, gate)
  const existing = runForSession(req.sessionId)
  if (existing !== null) {
    if (!agent.steer(req.prompt, blocks)) throw new Error('Wait for this session to finish stopping')
    forward({ type: 'steer', runId: existing, text: req.prompt, attachments: refs })
    releaseAttachments(req.attachmentIds)
    return { runId: existing, steered: true }
  }

  const controller = beginRun(req.runId, req.sessionId)
  registerRun(req.runId, req.sessionId)
  forward({ type: 'prompt', runId: req.runId, text: req.prompt, attachments: refs })
  // A rotating session's chip names the model this prompt went to.
  if (status.provider === ROTATE_PROVIDER) announceStatus()
  let terminal: AgentEvent | undefined
  void agent.run({
    runId: req.runId, prompt: req.prompt, signal: controller.signal, attachments: blocks,
    emit: (event) => {
      // Publish completion only after the agent has committed pending follow-ups
      // and released ownership. A viewer may immediately resume or fetch history.
      if (event.type === 'end' || event.type === 'error') terminal = event
      else forward(event)
    }
  }).catch((error: Error) => {
    terminal = { type: 'error', runId: req.runId, message: error.message }
  }).finally(() => {
    releaseAttachments(req.attachmentIds)
    finishRun(req.runId)
    const ended = terminal ?? { type: 'end', runId: req.runId, reason: 'complete' }
    forward(ended)
    persistSessions()
    // A run that finished hands over to the next queued prompt. One that was
    // paused or failed leaves the queue waiting, for a resume or a fix.
    if (ended.type === 'end' && ended.reason === 'complete') sendNextQueued(req.sessionId, gate)
  })
  // The run records its prompt before its first await, so the history already
  // holds it here — and an antichat's first prompt is what names it.
  announceTitle(req.sessionId)
  return { runId: req.runId, steered: false }
}

/**
 * Answers the last prompt again: the reply, and the files its run changed,
 * are taken back, and the same prompt — attachments and all — goes out as a
 * new run, on another model when one is named. The viewer that asked has
 * already drawn the retry; everyone else redraws from the main process.
 */
export async function regenerate(
  sessionId: string,
  runId: string,
  choice: ProviderSelection | null,
  gate: ApprovalGate,
  from: 'desktop' | 'phone'
): Promise<{ runId: string; steered: boolean }> {
  if (runForSession(sessionId) !== null) throw new Error('Pause this session before retrying')
  if (choice !== null) {
    selectProvider(choice, sessionId)
    announceStatus()
  }
  // Checked before anything is taken back: a retry that cannot start must
  // leave the answer it would have replaced where it is.
  const status = getStatus(sessionId)
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'Agent is not ready')
  const taken = takeBackPrompt(sessionId, 1)
  if (taken === null) throw new Error('There is no prompt to answer again')
  announceHistory(sessionId, from)
  return submitPrompt(
    { sessionId, runId, prompt: taken.prompt, attachmentIds: [] },
    gate,
    { blocks: taken.blocks, attachments: taken.attachments }
  )
}

/**
 * Queues a prompt to run after the session's current run finishes. With
 * nothing running there is nothing to wait for, and it is sent at once.
 */
export async function queuePrompt(req: AgentRequest, gate: ApprovalGate): Promise<{ runId: string; queued: boolean }> {
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 200_000) {
    throw new Error('Enter a prompt of at most 200,000 characters')
  }
  if (!Array.isArray(req.attachmentIds) || req.attachmentIds.some((id) => typeof id !== 'string')) {
    throw new Error('Invalid attachment IDs')
  }
  const running = runForSession(req.sessionId)
  if (running === null) {
    const started = await submitPrompt(req, gate)
    return { runId: started.runId, queued: false }
  }
  enqueue(req.sessionId, req.prompt, req.attachmentIds, stagedRefs(req.attachmentIds))
  return { runId: running, queued: true }
}

/** Takes a queued prompt out; its files are let go unless the caller keeps the text to edit. */
export function unqueuePrompt(sessionId: string, id: string): QueuedPrompt | null {
  const entry = removeQueued(sessionId, id)
  if (entry === undefined) return null
  releaseAttachments(entry.attachmentIds)
  return { id: entry.id, text: entry.text, attachments: entry.attachments }
}

/** The session was deleted: nothing it queued will ever be sent. */
export function forgetQueue(sessionId: string): void {
  for (const entry of clearQueue(sessionId)) releaseAttachments(entry.attachmentIds)
}

function sendNextQueued(sessionId: string, gate: ApprovalGate): void {
  const next = dequeue(sessionId)
  if (next === undefined) return
  const { attachmentIds, ...shown } = next
  void submitPrompt({ sessionId, runId: randomUUID(), prompt: next.text, attachmentIds }, gate).catch(() => {
    // It could not start — the model is not ready, the files are gone. It
    // waits at the front of the line rather than vanishing.
    requeue(sessionId, { ...shown, attachmentIds })
  })
}
