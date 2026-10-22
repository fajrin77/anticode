// Live free-route diagnostics. Keys are decrypted only inside Electron and are never returned.
import { _electron as electron } from 'playwright'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
const profile = await mkdtemp(path.join(tmpdir(), 'anticode-tokenharbor-'))
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const saved = JSON.parse(await readFile(path.join(homedir(), 'Library/Application Support/anticode/providers.json'), 'utf8')).providers
const config = saved.find(p => new URL(p.baseURL).hostname === 'tokenharbor.ai')
if (!config) throw new Error('No TokenHarbor connection')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: '/Applications/anticode.app/Contents/MacOS/anticode', args: [`--user-data-dir=${profile}`], env })
try {
  const report = await app.evaluate(async ({ safeStorage, net }, { config, catalogue, native }) => {
    const decode = value => value.startsWith('safe:v1:') ? safeStorage.decryptString(Buffer.from(value.slice(8), 'base64')) : value
    const keys = [...new Set([config.apiKey, ...(config.apiKeys ?? [])].filter(Boolean).map(decode))]
    const results = []
    for (let slot = 0; slot < keys.length; slot++) {
      const key = keys[slot]
      const scrub = value => keys.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value ?? '')).replace(/sk-[\w-]+/g, '[redacted]').slice(0, 650)
      for (const model of catalogue ? ['catalogue'] : ['deepseek-v4.1-flash:free', 'mimo-v2.6-flash:free']) {
        let status, phase = 'headers'; const started = Date.now()
        try {
          const response = await (native ? net.fetch.bind(net) : fetch)(config.baseURL.replace(/\/$/, '') + (catalogue ? '/models' : '/chat/completions'), { method: catalogue ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': 'anticode/tokenharbor-diagnostic' }, ...(!catalogue ? { body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply only OK.' }], max_tokens: 32, stream: true }) } : {}), signal: AbortSignal.timeout(catalogue ? 10000 : 60000) })
          status = response.status; phase = 'body'
          const raw = await response.text()
          let json; try { json = JSON.parse(raw) } catch {}
          const chunks = raw.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).flatMap(line => { try { return [JSON.parse(line.slice(6))] } catch { return [] } })
          const error = json?.error ?? chunks.find(c => c.error)?.error
          results.push({ slot: slot + 1, model, status: response.status, durationMs: Date.now() - started, ...(catalogue ? { freeModels: (json?.data ?? []).filter(m => m.id?.endsWith(':free')).map(m => m.id) } : {}), hasText: Boolean(json?.choices?.[0]?.message?.content || chunks.some(c => c.choices?.some(choice => choice.delta?.content))), finishReason: chunks.flatMap(c => c.choices ?? []).find(c => c.finish_reason)?.finish_reason, ...(error ? { code: error.code, error: scrub(error.message ?? error) } : {}), ...(!response.ok && !error ? { error: raw.startsWith('<') ? 'HTML gateway rejection' : scrub(raw) } : {}) })
        } catch (error) { results.push({ slot: slot + 1, model, status, phase, durationMs: Date.now() - started, error: error.name, code: error.cause?.code }) }
      }
    }
    return { at: new Date().toISOString(), transport: native ? 'electron-net' : 'node-fetch', uniqueKeys: keys.length, results }
  }, { config, catalogue: process.argv.includes('--catalogue'), native: process.argv.includes('--native') })
  await writeFile(`/tmp/anticode-tokenharbor-${process.argv.includes('--catalogue') ? 'catalogue' : 'results'}${process.argv.includes('--native') ? '-native' : ''}-20261022.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await app.close() }
