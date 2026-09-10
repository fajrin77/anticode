import type { RoutedAgentEvent } from '@shared/ipc'
import type { ApprovalGate } from './approval/types'
import { attachmentsFor, blocksOf, refsOf, releaseAttachments } from './attachments/registry'
import { forward } from './remote/bus'
import { runForSession } from './runs'
import { getSession } from './runtime'

/**
 * A prompt sent to a session that is already working joins the run in
 * progress instead of being refused — the work in hand carries on, and the new
 * instruction is taken in at its next step. Every viewer is told at once, so
 * the prompt shows as sent the moment it is sent, on the desktop and the phone.
 *
 * Answers with the run that took the prompt, or null when there was none to
 * take it (none running, or the one there is already stopping); the caller
 * then starts a run of its own.
 */
export async function steerRunning(
  sessionId: string,
  prompt: string,
  attachmentIds: string[],
  gate: ApprovalGate
): Promise<string | null> {
  const runId = runForSession(sessionId)
  if (runId === null) return null
  const agent = getSession(sessionId, gate)
  const sent = attachmentsFor(sessionId, attachmentIds)
  const blocks = await blocksOf(sent)
  if (!agent.steer(prompt, blocks)) return null
  forward({ type: 'steer', runId, text: prompt, attachments: refsOf(sent), sessionId } as RoutedAgentEvent)
  releaseAttachments(attachmentIds)
  return runId
}
