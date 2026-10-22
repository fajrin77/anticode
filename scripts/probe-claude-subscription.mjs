// Explicit, bounded live diagnostic. Reads existing 9Router credentials in memory;
// never prints tokens, refreshes grants, changes router settings, or falls back to API billing.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import path from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
const db = new DatabaseSync(path.join(homedir(), '.9router/db/data.sqlite'), { readOnly: true })
const row = db.prepare("SELECT data FROM providerConnections WHERE provider = 'claude' AND isActive = 1 LIMIT 1").get()
if (!row) throw new Error('No active Claude OAuth account in 9Router')
const tokens = JSON.parse(row.data)
const key = db.prepare('SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1').get()?.key
db.close()
const scrub = value => String(value ?? '').split(tokens.accessToken).join('[redacted]').split(key ?? '\0').join('[redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 700)
const headers = { 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'anticode/subscription-diagnostic' }
const access = {}
for (const name of ['profile', 'usage']) {
  const response = await fetch(`https://api.anthropic.com/api/oauth/${name}`, {
    headers: { ...headers, authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) { console.log(JSON.stringify({ blocked: true, stage: name, status: response.status })); process.exit(1) }
  access[name] = await response.json()
}
const subscribed = access.profile.organization?.subscription_status === 'active' &&
  (access.profile.account?.has_claude_pro === true || access.profile.account?.has_claude_max === true ||
    ['claude_team', 'claude_enterprise'].includes(access.profile.organization?.organization_type))
if (!subscribed || access.usage.extra_usage?.is_enabled !== false) {
  console.log(JSON.stringify({ blocked: true, subscribed, extraUsageEnabled: access.usage.extra_usage?.is_enabled ?? null })); process.exit(1)
}
const client = new Anthropic({ apiKey: null, authToken: tokens.accessToken, defaultHeaders: headers, maxRetries: 0, timeout: 20000 })
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), subscribed: true, extraUsageEnabled: false }))
for (const model of process.argv.includes('--router-tools-only') ? [] : ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
  try {
    const result = await client.messages.stream({ model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply only OK.' }] }).finalMessage()
    console.log(JSON.stringify({ route: 'direct-anticode-identity', model, returnedModel: result.model, status: 200, hasText: result.content.some(b => b.type === 'text' && b.text.trim()), stopReason: result.stop_reason }))
  } catch (error) { console.log(JSON.stringify({ route: 'direct-anticode-identity', model, status: error.status, errorType: error.error?.error?.type, detail: scrub(error.error?.error?.message), requestId: error.headers?.get('request-id') })) }
}
// Optional comparison with the existing router. Explicit cc/ route only; no combos.
if (process.argv.includes('--compare-router') && key) {
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    try {
      const response = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `cc/${model}`, max_tokens: 32, messages: [{ role: 'user', content: 'Reply only OK.' }], stream: false }), signal: AbortSignal.timeout(25000)
      })
      const result = await response.json()
      console.log(JSON.stringify({ route: '9router-cc', model, status: response.status, returnedModel: result.model, hasText: Boolean(result.choices?.[0]?.message?.content), errorType: result.error?.type, ...(result.error ? { detail: scrub(result.error.message) } : {}) }))
    } catch (error) { console.log(JSON.stringify({ route: '9router-cc', model, errorType: error.name })) }
  }
}
if (process.argv.includes('--router-tools-only') && key) {
  const model = 'cc/claude-sonnet-5-5'
  const router = new OpenAI({ apiKey: key, baseURL: 'http://127.0.0.1:20128/v1', maxRetries: 0, timeout: 25000 })
  const tools = [{ type: 'function', function: { name: 'check_fixture', description: 'Read a harmless in-memory fixture.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }]
  const messages = [{ role: 'user', content: 'Call check_fixture once. After receiving the fixture, reply only OK.' }]
  try {
    const first = await router.chat.completions.create({ model, max_tokens: 256, tools, messages })
    const call = first.choices[0]?.message.tool_calls?.[0]
    if (!call || call.type !== 'function' || call.function.name !== 'check_fixture') throw new Error('Expected fixture tool was not requested')
    const stream = await router.chat.completions.create({ model, max_tokens: 128, tools, messages: [...messages, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: 'fixture: ready' }], stream: true })
    let hasText = false, returnedModel, finishReason
    for await (const chunk of stream) {
      returnedModel = chunk.model ?? returnedModel
      hasText ||= Boolean(chunk.choices[0]?.delta?.content?.trim())
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason
    }
    console.log(JSON.stringify({ route: '9router-cc', model, firstReturnedModel: first.model, returnedModel, requests: 2, toolRoundTrip: true, streaming: true, hasText, finishReason }))
  } catch (error) { console.log(JSON.stringify({ route: '9router-cc', model, status: error.status, detail: scrub(error.message), toolRoundTrip: false })) }
}
