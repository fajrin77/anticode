import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkProblemsTool } from './checkProblems'
import { subagentTools } from './index'
import type { ToolContext } from './types'

let root: string
let context: ToolContext

async function fakeBin(name: string, script: string): Promise<void> {
  const dir = path.join(root, 'node_modules', '.bin')
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, `#!/bin/sh\n${script}\n`)
  await chmod(file, 0o755)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'anticode-problems-'))
  context = { workspaceRoot: root, signal: new AbortController().signal }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('check_problems', () => {
  it('reports TypeScript errors from the workspace toolchain', async () => {
    await writeFile(path.join(root, 'tsconfig.json'), '{}')
    await fakeBin('tsc', 'echo "src/a.ts(1,1): error TS2322: wrong type"; exit 2')
    const output = await checkProblemsTool.prepare({}).execute(context)
    expect(output.text).toContain('TypeScript:')
    expect(output.text).toContain('TS2322')
  })

  it('says so when the project is clean', async () => {
    await writeFile(path.join(root, 'tsconfig.json'), '{}')
    await fakeBin('tsc', 'exit 0')
    const output = await checkProblemsTool.prepare({}).execute(context)
    expect(output.text).toContain('no problems found')
  })

  it('runs ESLint when configured, scoped to a path', async () => {
    await writeFile(path.join(root, 'eslint.config.js'), 'export default []')
    await fakeBin('eslint', 'echo "lint of $1"; echo "1 problem"; exit 1')
    const output = await checkProblemsTool.prepare({ path: 'src' }).execute(context)
    expect(output.text).toContain('ESLint:')
  })

  it('rejects paths outside the workspace', async () => {
    await expect(checkProblemsTool.prepare({ path: '../luar' }).execute(context)).rejects.toThrow()
  })

  it('never downloads: missing toolchain is reported, not fetched', async () => {
    const output = await checkProblemsTool.prepare({}).execute(context)
    expect(output.text).toMatch(/No checkers available/)
  })

  it('runs free in Default mode and is in the sub-agent kit', async () => {
    expect(checkProblemsTool.prepare({}).risk).toBe('low')
    expect(subagentTools().some((tool) => tool.name === 'check_problems')).toBe(true)
  })

  it('aborts when the run is cancelled', async () => {
    await writeFile(path.join(root, 'tsconfig.json'), '{}')
    await fakeBin('tsc', 'sleep 30')
    const controller = new AbortController()
    const pending = checkProblemsTool.prepare({}).execute({ ...context, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
    // The fixture toolchain is untouched apart from the run.
    expect(await readFile(path.join(root, 'tsconfig.json'), 'utf8')).toBe('{}')
  })
})
