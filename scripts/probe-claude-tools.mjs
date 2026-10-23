// Live measurement: tool schemas, large tool results and multi-step runs.
// Bundle first (see probe-claude-cache.mjs). Not a coding benchmark; one model/account.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'
import { ClaudeCodeProvider } from '../out/claude-code-probe.mjs'
const db = new DatabaseSync(path.join(homedir(), '.9router/db/data.sqlite'), { readOnly: true })
const tokens = JSON.parse(db.prepare("SELECT data FROM providerConnections WHERE provider = 'claude' AND isActive = 1 LIMIT 1").get().data)
db.close()
const model = process.argv[2] ?? 'claude-sonnet-5-5'
const provider = new ClaudeCodeProvider('tools-probe', model, tokens.accessToken)
const schema = { type: 'object', properties: { query: { type: 'string', description: 'What to look up.' } }, required: ['query'], additionalProperties: false }
const tools = ['read_file', 'search_files', 'run_command', 'edit_file', 'list_directory', 'fetch_url'].map(name => ({ name, description: `Fixture tool ${name}. Returns canned text.`, inputSchema: schema }))
const system = 'You are a terse assistant verifying token usage. Use tools only when asked.'
const bulk = 'fixture line with canned content for token measurement. '.repeat(250)
const messages = []
const rows = []
let sent = 0
async function run(text, toolList) {
  const controller = new AbortController()
  messages.push({ role: 'user', content: [{ type: 'text', text }] })
  for (;;) {
    let response
    for await (const e of provider.chat({ sessionId: 'tools-probe', system, messages, tools: toolList, maxTokens: 1024, signal: controller.signal })) if (e.type === 'response') response = e.response
    rows.push({ call: ++sent, ...response.usage, stop: response.stopReason })
    messages.push({ role: 'assistant', content: response.content })
    const uses = response.content.filter(b => b.type === 'tool_use')
    if (!uses.length) break
    messages.push({ role: 'user', content: uses.map(u => ({ type: 'tool_result', toolUseId: u.id, content: bulk, isError: false })) })
  }
  controller.abort()
}
try {
  await run('Say hi in one word.', [])
  await run('Say hi in one word.', tools)
  await run('Call read_file with query "a", then search_files with query "b", then run_command with query "c" (one at a time), then reply DONE.', tools)
  await run('Say OK in one word.', tools)
} catch (e) { rows.push({ error: String(e.message).split(tokens.accessToken).join('[redacted]').slice(0, 400) }) }
for (const r of rows) console.log(JSON.stringify(r))
