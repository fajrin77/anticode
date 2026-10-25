import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CursorCliProvider, cursorModels } from './cursorCli'
import type { ProviderEvent } from './types'
afterEach(() => vi.unstubAllEnvs())

it.skipIf(process.platform === 'win32')('runs a fixture CLI in an isolated profile and returns tools to Anticode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cursor-fixture-'))
  const script = path.join(dir, 'agent')
  const receipt = path.join(dir, 'receipt.json')
  try {
    await writeFile(script, `#!${process.execPath}
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.CURSOR_CONFIG_DIR + '/cli-config.json'));
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), config, credentialStore: process.env.AGENT_CLI_CREDENTIAL_STORE, inheritedSecret: process.env.OPENAI_API_KEY }));
if (process.argv.includes('--list-models')) { console.log('fixture-model - Fixture'); process.exit(0); }
let input = ''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
if (!input.includes('Available tools:')) process.exit(2);
console.log(JSON.stringify({ result: JSON.stringify({ text: 'reading', tool_calls: [{name:'read_file', arguments:{path:'file'}}] }), model:'fixture-model', usage:{input_tokens:10, output_tokens:5} }));
});
`)
    await chmod(script, 0o700)
    vi.stubEnv('ANTICODE_CURSOR_CLI', script)
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit')
    expect(await cursorModels('fixture')).toEqual(['fixture-model'])
    const events: ProviderEvent[] = []
    const provider = new CursorCliProvider('fixture', 'fixture-model')
    for await (const event of provider.chat({ system: 'test', messages: [], tools: [{ name: 'read_file', description: '', inputSchema: {} }], maxTokens: 100, signal: new AbortController().signal })) events.push(event)
    const response = events.find((e) => e.type === 'response')
    expect(response?.type === 'response' && response.response.stopReason).toBe('tool_use')
    const record = JSON.parse(await readFile(receipt, 'utf8'))
    expect(record.args).not.toContain('--force')
    expect(record.args).toContain('ask')
    expect(record.config.permissions.deny).toContain('Shell(*)')
    expect(record.credentialStore).toBe('memory')
    expect(record.inheritedSecret).toBeUndefined()
    await expect(readFile(path.join(record.cwd, 'config', 'cli-config.json'))).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
