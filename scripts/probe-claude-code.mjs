// Run after bundling src/main/providers/claudeCode.ts to out/claude-code-probe.mjs.
// Live subscription probe: two fixture requests per model; no filesystem tools.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { ClaudeCodeProvider } from '../out/claude-code-probe.mjs'
const db = new DatabaseSync(path.join(homedir(), '.9router/db/data.sqlite'), { readOnly: true })
const tokens = JSON.parse(db.prepare("SELECT data FROM providerConnections WHERE provider = 'claude' AND isActive = 1 LIMIT 1").get().data)
db.close()
for (const name of ['profile', 'usage']) {
  const r = await fetch(`https://api.anthropic.com/api/oauth/${name}`, { headers: { authorization: `Bearer ${tokens.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'anticode/subscription-diagnostic' }, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`Preflight ${name} HTTP ${r.status}`)
  const d = await r.json()
  if (name === 'profile' && (d.organization?.subscription_status !== 'active' || !(d.account?.has_claude_pro === true || d.account?.has_claude_max === true))) throw new Error('Active personal subscription not confirmed')
  if (name === 'usage' && d.extra_usage?.is_enabled !== false) throw new Error('Disable Extra usage first')
}
const selected = process.argv.slice(2).filter(arg => arg.startsWith('claude-'))
for (const model of selected.length ? selected : ['claude-sonnet-5-5', 'claude-opus-5-5']) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90000)
  const provider = new ClaudeCodeProvider('diagnostic', model, tokens.accessToken)
  const params = { sessionId: model, system: 'You are helping Anticode verify its subscription connection. Use the supplied fixture tool.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Call check_fixture once, then reply only OK after reading its result.' }] }], tools: [{ name: 'check_fixture', description: 'Read an in-memory test fixture.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], maxTokens: 256, signal: controller.signal }
  try {
    let first, final, streamed = false
    for await (const e of provider.chat(params)) { if (e.type === 'response') first = e.response }
    const call = first?.content.find(b => b.type === 'tool_use')
    if (!call || call.name !== 'check_fixture') throw new Error('Expected fixture tool was not called')
    params.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'fixture: ready', isError: false }] })
    for await (const e of provider.chat(params)) { if (e.type === 'text_delta') streamed ||= Boolean(e.text); if (e.type === 'response') final = e.response }
    console.log(JSON.stringify({ at: new Date().toISOString(), route: 'official-claude-code', model, toolRoundTrip: true, streaming: streamed, hasFinalText: final?.content.some(b => b.type === 'text' && b.text.trim()), stopReason: final?.stopReason, extraUsageEnabled: false }))
    if (process.argv.includes('--vision')) {
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer()
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'What is the dominant color? Reply only RED, GREEN, or BLUE.' }, { type: 'image', mediaType: 'image/png', data: png.toString('base64') }] }]
      const vision = { ...params, messages, tools: [], sessionId: model + '-vision' }
      const get = async () => { let response; for await (const e of provider.chat(vision)) { if (e.type === 'response') response = e.response }; return response }
      const firstImage = await get()
      const red = firstImage?.content.some(b => b.type === 'text' && b.text.trim().toUpperCase() === 'RED')
      messages.push({ role: 'assistant', content: firstImage.content }, { role: 'user', content: [{ type: 'text', text: 'Look at the earlier image again. Reply only with its dominant color: RED, GREEN, or BLUE.' }] })
      const restored = await get()
      console.log(JSON.stringify({ route: 'official-claude-code', model, vision: red, restoredImage: restored?.content.some(b => b.type === 'text' && b.text.trim().toUpperCase() === 'RED') }))
    }
  } catch (e) { console.log(JSON.stringify({ route: 'official-claude-code', model, error: String(e.message).split(tokens.accessToken).join('[redacted]').slice(0, 900) })) }
  finally { clearTimeout(timeout); controller.abort() }
}
