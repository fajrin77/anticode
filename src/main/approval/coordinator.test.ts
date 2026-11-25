import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it } from 'vitest'
import { ApprovalCoordinator } from './coordinator'
import { ApprovalPolicy } from './policy'

it('rejects cancellation that happens while the preview is being computed', async () => {
  const target = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: () => {} })
  const gate = new ApprovalCoordinator(new ApprovalPolicy(), () => target as unknown as WebContents)
  const controller = new AbortController()
  const result = gate.authorize({ sessionId: 's', runId: 'r', toolName: 'write_file', risk: 'medium', signal: controller.signal,
    preview: async () => { controller.abort(); return { kind: 'text', subject: 'file', detail: 'write' } }
  })
  await expect(result).resolves.toBe(false)
})
it('never auto-approves a call that is already cancelled', async () => {
  const policy = new ApprovalPolicy(); policy.setAutoApprove(true)
  const gate = new ApprovalCoordinator(policy, () => null)
  await expect(gate.authorize({sessionId: 's', runId: 'r', toolName: 'write_file', risk: 'medium', signal: AbortSignal.abort(), preview: async () => { throw new Error('must not preview') }})).resolves.toBe(false)
})
it('scopes Always allow to a single session', () => {
  const policy = new ApprovalPolicy(); policy.allowAlways('write_file', 'a')
  expect(policy.needsApproval('write_file', 'medium', 'a')).toBe(false)
  expect(policy.needsApproval('write_file', 'medium', 'b')).toBe(true)
})
it('rejects immediately instead of hanging when no desktop window or remote viewer exists', async () => {
  const gate = new ApprovalCoordinator(new ApprovalPolicy(), () => null)
  const result = await gate.authorize({
    sessionId: 's', runId: 'r',
    toolName: 'write_file',
    risk: 'medium',
    signal: new AbortController().signal,
    preview: async () => ({ kind: 'text', subject: 'file', detail: 'write' })
  })
  expect(result).toBe(false)
})

it('exposes the session and workspace and requires an explicit one-time decision for high risk', async () => {
  let notify!: () => void
  const shown = new Promise<void>(resolve => { notify = resolve })
  const target = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: notify })
  const gate = new ApprovalCoordinator(new ApprovalPolicy(), () => target as unknown as WebContents)
  const result = gate.authorize({
    sessionId: 'background', workspaceRoot: '/repo/other', runId: 'r', toolName: 'run_command', risk: 'high',
    signal: new AbortController().signal,
    preview: async () => ({ kind: 'command', subject: 'command', detail: 'detail' })
  })
  await shown
  const [pending] = gate.listPending()
  expect(pending).toMatchObject({ sessionId: 'background', workspaceRoot: '/repo/other', allowAlways: false })
  gate.resolve(pending!.requestId, 'always')
  expect(gate.listPending()).toHaveLength(1)
  gate.resolve(pending!.requestId, 'reject')
  await expect(result).resolves.toBe(false)
  expect(gate.listPending()).toHaveLength(0)
})
