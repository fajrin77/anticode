import type { AgentEvent, AgentRequest, AttachmentRef, ProviderSelection } from '@shared/ipc'
import { ROTATE_PROVIDER } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import type { ContentBlock } from './providers/types'
import { attachmentsFor, blocksOf, refsOf, releaseAttachments } from './attachments/registry'
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
    forward(terminal ?? { type: 'end', runId: req.runId, reason: 'complete' })
    persistSessions()
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
