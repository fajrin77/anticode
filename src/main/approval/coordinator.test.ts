import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it } from 'vitest'
import { ApprovalCoordinator } from './coordinator'
import { ApprovalPolicy } from './policy'

it('rejects cancellation that happens while the preview is being computed', async () => {
  const target = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} })
  const gate = new ApprovalCoordinator(new ApprovalPolicy(), () => target as unknown as WebContents)
  const controller = new AbortController()
  const result = gate.authorize({ runId: 'r', toolName: 'write_file', risk: 'medium', signal: controller.signal,
    preview: async () => { controller.abort(); return { kind: 'text', subject: 'file', detail: 'write' } }
  })
  await expect(result).resolves.toBe(false)
})
it('never auto-approves a call that is already cancelled', async () => {
  const policy = new ApprovalPolicy(); policy.setAutoApprove(true)
  const gate = new ApprovalCoordinator(policy, () => null)
  await expect(gate.authorize({runId: 'r', toolName: 'write_file', risk: 'medium', signal: AbortSignal.abort(), preview: async () => { throw new Error('must not preview') }})).resolves.toBe(false)
})
it('scopes Always allow to a single session', () => {
  const policy = new ApprovalPolicy(); policy.allowAlways('write_file', 'a')
  expect(policy.needsApproval('write_file', 'medium', 'a')).toBe(false)
  expect(policy.needsApproval('write_file', 'medium', 'b')).toBe(true)
})
