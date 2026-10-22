// Bounded live diagnostics. Credentials remain inside the installed app's secure-storage context.
// Prints only key slot numbers, quota metadata, status and scrubbed provider errors.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
const profile = await mkdtemp(path.join(tmpdir(), 'anticode-access-probe-'))
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ updates: { autoCheck: false } }))
const saved = JSON.parse(await readFile(path.join(process.argv[2] ?? path.join(homedir(), 'Library/Application Support/anticode'), 'providers.json'), 'utf8')).providers
const configs = saved.filter(config => config.baseURL === 'https://openrouter.ai/api/v1' || config.baseURL === 'https://opencode.ai/zen/go/v1')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: '/Applications/anticode.app/Contents/MacOS/anticode', args: [`--user-data-dir=${profile}`], env })
try {
  const results = await app.evaluate(async ({ safeStorage }, configs) => {
    const decode = value => value.startsWith('safe:v1:') ? safeStorage.decryptString(Buffer.from(value.slice(8), 'base64')) : value
    const results = []
    for (const config of configs) {
      const keys = [...new Set([config.apiKey, ...(config.apiKeys ?? [])].filter(Boolean).map(decode))]
      for (let slot = 0; slot < keys.length; slot++) {
        const key = keys[slot]
        const scrub = value => String(value ?? '').split(key).join('[redacted]').replace(/sk-[\w-]+/g, '[redacted]').slice(0, 450)
        const get = async (url, body) => {
          try {
            const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'anticode/0.0.60', ...(config.baseURL.includes('opencode.ai') ? { 'x-opencode-session': 'anticode-access-diagnostic' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) })
            const text = await response.text()
            let json; try { json = JSON.parse(text) } catch {}
            if (url.endsWith('/key')) return { status: response.status, limit: json?.data?.limit, remaining: json?.data?.limit_remaining, isFreeTier: json?.data?.is_free_tier, dailyFreeRequests: json?.data?.free_model_daily_requests, ...(!response.ok ? { error: scrub(json?.error?.message ?? text) } : {}) }
            const frames = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').flatMap(line => { try { return [JSON.parse(line.slice(6))] } catch { return [] } })
            const error = json?.error ?? frames.find(frame => frame.error)?.error
            return { status: response.status, ...(error ? { error: scrub(error.message ?? error), code: error.code } : {}), hasText: Boolean(json?.choices?.[0]?.message?.content || frames.some(frame => frame.choices?.some(choice => choice.delta?.content))), finishReason: json?.choices?.[0]?.finish_reason ?? frames.flatMap(frame => frame.choices ?? []).find(choice => choice.finish_reason)?.finish_reason }
          } catch (error) { return { error: error.name } }
        }
        if (config.baseURL.includes('openrouter.ai')) {
          const quota = await get(config.baseURL + '/key')
          for (const model of ['meta/muse-spark-1.3', 'z-ai/glm-5.3-flashx']) {
            results.push({ provider: 'OpenRouter', slot: slot + 1, model, quota, inference: await get(config.baseURL + '/chat/completions', { model, messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 32, stream: true }) })
          }
        } else {
          const model = 'minimax-m3.1-flash-free'
          results.push({ provider: 'OpenCode configured Go endpoint', slot: slot + 1, model, sessionHeader: true, inference: await get(config.baseURL + '/chat/completions', { model, messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 128, stream: true }) })
        }
      }
    }
    return results
  }, configs)
  await writeFile('/tmp/anticode-configured-access-results.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ report: '/tmp/anticode-configured-access-results.json', probes: results.length }))
} finally { await app.close() }
