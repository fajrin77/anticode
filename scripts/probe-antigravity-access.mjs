// Bounded live Antigravity probe; never prints tokens, identities or response bodies.
// Reports, per account: plan tier, catalogue status and model ids per endpoint,
// and whether one short generateContent for each requested model returns text.
// Usage: node scripts/probe-antigravity-access.mjs [model ...]
import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-4-neon', 'gemini-4-carbon']
const profile = await mkdtemp(path.join(tmpdir(), 'anticode-antigravity-probe-'))
let app
try {
  const bundle = path.join(profile, 'probe.cjs')
  await build({ stdin: { contents: `
    import { readFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import path from 'node:path';
    import { refreshAntigravity, antigravityHeaders, ANTIGRAVITY_BASES } from './src/main/auth/antigravity';
    export async function run(safeStorage, models) {
      const store = JSON.parse(readFileSync(path.join(homedir(), 'Library/Application Support/anticode/auth-accounts.json'), 'utf8'));
      const results = [];
      for (const [slot, entry] of store.accounts.filter(e => e.account.kind === 'antigravity').entries()) {
        let tokens;
        try { tokens = JSON.parse(safeStorage.decryptString(Buffer.from(entry.sealed.slice(8), 'base64'))); }
        catch { results.push({ slot: slot + 1, error: 'secure tokens cannot be decrypted' }); continue; }
        if (!tokens.expiresAt || tokens.expiresAt < Date.now() + 60000) {
          try { tokens = await refreshAntigravity(tokens); } catch { results.push({ slot: slot + 1, error: 'token refresh failed' }); continue; }
        }
        const post = (base, method, body) => fetch(base + '/v1internal:' + method, { method: 'POST', headers: antigravityHeaders(tokens.accessToken), body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
        const plan = await post('https://cloudcode-pa.googleapis.com', 'loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } });
        const data = await plan.json().catch(() => ({}));
        const project = typeof data.cloudaicompanionProject === 'string' ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
        results.push({ slot: slot + 1, phase: 'plan', status: plan.status, hasProject: !!project, current: data.currentTier?.id, paid: data.paidTier?.id });
        for (const base of ANTIGRAVITY_BASES) {
          const r = await post(base, 'fetchAvailableModels', { project }).catch((e) => ({ status: e.name }));
          const body = r.json ? await r.json().catch(() => ({})) : {};
          results.push({ slot: slot + 1, base, status: r.status, models: Object.keys(body.models ?? {}).sort() });
          for (const model of models) {
            const g = await post(base, 'generateContent', { project, model, requestType: 'agent', request: { contents: [{ role: 'user', parts: [{ text: 'Reply only OK.' }] }], generationConfig: { maxOutputTokens: 32 } } }).catch((e) => ({ status: e.name }));
            const out = g.json ? await g.json().catch(() => ({})) : {};
            const parts = (out.response ?? out).candidates?.[0]?.content?.parts ?? [];
            results.push({ slot: slot + 1, base, model, status: g.status, hasText: parts.some((p) => p.text && !p.thought), reason: out.error?.status });
          }
        }
      }
      return { time: new Date().toISOString(), results };
    }
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle, logLevel: 'silent' })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'anticode', main: 'main.cjs' }))
  await writeFile(path.join(profile, 'main.cjs'), "const {app}=require('electron'); globalThis.anticodeProbe=require('./probe.cjs'); app.setName('anticode'); app.whenReady().then(()=>{});")
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [profile, `--user-data-dir=${profile}`], env, timeout: 20000 })
  const report = await app.evaluate(async ({ safeStorage }, list) => globalThis.anticodeProbe.run(safeStorage, list), models)
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (app) await app.close()
  await rm(profile, { recursive: true, force: true })
}
