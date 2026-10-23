// Live measurement: does the prefix cache survive across prompts of one session?
// Bundle first:  npx esbuild src/main/providers/claudeCode.ts --bundle --platform=node --format=esm \
//   --packages=external --outfile=out/claude-code-probe.mjs --banner:js="import{createRequire as __cr}from'node:module';"
// Reads the existing 9Router account once; never prints tokens. Not a coding benchmark.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'
import { ClaudeCodeProvider } from '../out/claude-code-probe.mjs'
const db = new DatabaseSync(path.join(homedir(), '.9router/db/data.sqlite'), { readOnly: true })
const tokens = JSON.parse(db.prepare("SELECT data FROM providerConnections WHERE provider = 'claude' AND isActive = 1 LIMIT 1").get().data)
db.close()
const model = process.argv[2] ?? 'claude-sonnet-5-5'
const provider = new ClaudeCodeProvider('cache-probe', model, tokens.accessToken)
const filler = 'Line of project notes about caching behaviour and token accounting. '.repeat(300)
const messages = []
const system = 'You are a terse assistant verifying prompt-cache behaviour. Reply with one short sentence.'
for (let turn = 1; turn <= 3; turn++) {
  const controller = new AbortController()
  messages.push({ role: 'user', content: [{ type: 'text', text: (turn === 1 ? filler + '\n' : '') + `Turn ${turn}: say the number ${turn}.` }] })
  let response
  try {
    for await (const e of provider.chat({ sessionId: 'cache-probe', system, messages, tools: [], maxTokens: 512, signal: controller.signal })) if (e.type === 'response') response = e.response
    messages.push({ role: 'assistant', content: response.content })
    console.log(JSON.stringify({ turn, model, usage: response.usage }))
  } catch (e) { console.log(JSON.stringify({ turn, error: String(e.message).split(tokens.accessToken).join('[redacted]').slice(0, 500) })); break }
  finally { controller.abort() }
}
