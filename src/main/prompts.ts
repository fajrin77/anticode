import type { AgentEvent, AgentRequest } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import { attachmentsFor, blocksOf, refsOf, releaseAttachments } from './attachments/registry'
import { getSession, getStatus, persistSessions } from './runtime'
import { beginRun, finishRun, runForSession } from './runs'
import { forward, registerRun } from './remote/bus'

// Serialize admission, including attachment preparation, across both transports.
// The queue releases as soon as the run starts, so follow-ups still join it.
const admissions = new Map<string, Promise<unknown>>()

export function submitPrompt(req: AgentRequest, gate: ApprovalGate): Promise<{ runId: string; steered: boolean }> {
  const previous = admissions.get(req.sessionId) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(() => admit(req, gate))
  admissions.set(req.sessionId, pending)
  void pending.finally(() => {
    if (admissions.get(req.sessionId) === pending) admissions.delete(req.sessionId)
  }).catch(() => undefined)
  return pending
}

async function admit(req: AgentRequest, gate: ApprovalGate): Promise<{ runId: string; steered: boolean }> {
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 200_000) {
    throw new Error('Enter a prompt of at most 200,000 characters')
  }
  if (!Array.isArray(req.attachmentIds) || req.attachmentIds.some((id) => typeof id !== 'string')) {
    throw new Error('Invalid attachment IDs')
  }
  const sent = await attachmentsFor(req.sessionId, req.attachmentIds)
  const blocks = await blocksOf(req.sessionId, sent)
  // Preparation can outlive a deletion, model change, or a finishing run.
  // Recheck the current main-process state after that asynchronous work.
  const status = getStatus()
  if (!status.providerReady) throw new Error(status.blockedReason ?? 'Agent is not ready')
  const agent = getSession(req.sessionId, gate)
  const existing = runForSession(req.sessionId)
  if (existing !== null) {
    if (!agent.steer(req.prompt, blocks)) throw new Error('Wait for this session to finish stopping')
    forward({ type: 'steer', runId: existing, text: req.prompt, attachments: refsOf(sent) })
    releaseAttachments(req.attachmentIds)
    return { runId: existing, steered: true }
  }

  const controller = beginRun(req.runId, req.sessionId)
  registerRun(req.runId, req.sessionId)
  forward({ type: 'prompt', runId: req.runId, text: req.prompt, attachments: refsOf(sent) })
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
  return { runId: req.runId, steered: false }
}
