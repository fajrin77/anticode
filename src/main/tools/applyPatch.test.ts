import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { applyPatchTool } from './applyPatch'
import type { ToolContext } from './types'
import { AgentSession } from '../agent/loop'
import { allowAll } from '../approval/types'
import type { LLMProvider } from '../providers/types'

let root: string
let context: ToolContext
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-patch-'))
  context = { workspaceRoot: root, signal: new AbortController().signal }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const patch = (...body: string[]): { patch: string } => ({ patch: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') })

it('previews and applies multi-file changes with exact context and literal dollar text', async () => {
  await writeFile(path.join(root, 'a.ts'), 'first\r\nold\r\nlast\r\n')
  await writeFile(path.join(root, 'remove.ts'), 'remove')
  const call = applyPatchTool.prepare(patch('*** Update File: a.ts', '@@', ' first', '-old', '+$&', ' last', '*** Add File: nested/b.ts', '+new', '*** Delete File: remove.ts'))
  expect(call.risk).toBe('high')
  expect((await call.preview(context)).kind).toBe('diff')
  expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toContain('old')
  await call.execute(context)
  expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('first\r\n$&\r\nlast\r\n')
  expect(await readFile(path.join(root, 'nested/b.ts'), 'utf8')).toBe('new\n')
  await expect(readFile(path.join(root, 'remove.ts'))).rejects.toThrow()
})

it('validates all files before writing, refusing ambiguous context and path escape', async () => {
  await writeFile(path.join(root, 'a'), 'repeat\nrepeat\n')
  await expect(applyPatchTool.prepare(patch('*** Add File: b', '+new', '*** Update File: a', '@@', '-repeat', '+new')).execute(context)).rejects.toThrow(/2 locations/)
  await expect(readFile(path.join(root, 'b'))).rejects.toThrow()
  await expect(applyPatchTool.prepare(patch('*** Add File: ../outside', '+no')).execute(context)).rejects.toThrow(/outside/)
  await symlink(tmpdir(), path.join(root, 'link'))
  await expect(applyPatchTool.prepare(patch('*** Add File: link/outside', '+no')).execute(context)).rejects.toThrow(/outside/)
})

it('supports ordered hunks, EOF anchoring, and existing files without trailing newline', async () => {
  await writeFile(path.join(root, 'a'), 'one\ntwo\nthree\ntwo')
  await applyPatchTool.prepare(patch('*** Update File: a', '@@', '-one', '+first', '@@', '-two', '+last', '*** End of File')).execute(context)
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('first\ntwo\nthree\nlast')
  expect(() => applyPatchTool.prepare(patch('*** Move to: b'))).toThrow(/Unsupported/)
})

it('advertises GPT patch editing, executes it, and restores changed files on Revert', async () => {
  await writeFile(path.join(root, 'a'), 'before\n')
  let request = 0
  const provider: LLMProvider = { name: 'test', model: 'cx/gpt-6.1-sol', async *chat(params) {
    expect(params.tools.map((tool) => tool.name)).toContain('apply_patch')
    expect(params.tools.map((tool) => tool.name)).not.toContain('edit_file')
    expect(params.system).toContain('Use apply_patch')
    yield { type: 'response', response: { content: request++ === 0
      ? [{ type: 'tool_use', id: 'patch', name: 'apply_patch', input: patch('*** Update File: a', '@@', '-before', '+after', '*** Add File: b', '+new') }]
      : [{ type: 'text', text: 'done' }], stopReason: request === 1 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } }
  } }
  const agent = new AgentSession(provider, allowAll, 'code', root)
  await agent.run({ runId: 'patch-run', prompt: 'edit', signal: context.signal, emit: () => {} })
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('after\n')
  agent.revertLastTurn()
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('before\n')
  await expect(readFile(path.join(root, 'b'))).rejects.toThrow()
  agent.dispose()
})

it('restores earlier changes when a later filesystem write fails', async () => {
  await writeFile(path.join(root, 'a'), 'before\n')
  const call = applyPatchTool.prepare(patch('*** Update File: a', '@@', '-before', '+after', '*** Add File: parent', '+file', '*** Add File: parent/child', '+cannot-create'))
  await expect(call.execute(context)).rejects.toThrow(/Earlier changes restored/)
  expect(await readFile(path.join(root, 'a'), 'utf8')).toBe('before\n')
  await expect(readFile(path.join(root, 'parent'))).rejects.toThrow()
})
