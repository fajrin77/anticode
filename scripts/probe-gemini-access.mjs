// Bounded live subscription probes; never prints tokens, identities or response bodies.
import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const profile = await mkdtemp(path.join(tmpdir(), 'anticode-gemini-probe-'))
let app
try {
  const bundle = path.join(profile, 'probe.cjs')
  await build({ stdin: { contents: `
    import { readFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import path from 'node:path';
    import { GeminiCliProvider } from './src/main/providers/geminiCli';
    import { refreshGemini, GEMINI_CLOUD_BASE, geminiHeaders } from './src/main/auth/gemini';
    export async function run(safeStorage) {
      const store = JSON.parse(readFileSync(path.join(homedir(), 'Library/Application Support/anticode/auth-accounts.json'), 'utf8'));
      const results = [];
      for (const [slot, entry] of store.accounts.filter(e => e.account.kind === 'gemini').entries()) {
        if (!entry.sealed.startsWith('safe:v1:')) { results.push({slot: slot + 1, error: 'secure tokens unavailable'}); continue; }
        let tokens;
        try { tokens = JSON.parse(safeStorage.decryptString(Buffer.from(entry.sealed.slice(8), 'base64'))); }
        catch { results.push({slot: slot + 1, error: 'secure tokens cannot be decrypted in diagnostic app; use installed app authentication context'}); continue; }
        if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60000) {
          try { tokens = await refreshGemini(tokens); }
          catch { results.push({slot: slot + 1, error: 'token refresh failed; sign in again'}); continue; }
        }
        const plan = await fetch(GEMINI_CLOUD_BASE + '/v1internal:loadCodeAssist', {method:'POST', headers:geminiHeaders(tokens.accessToken), body:JSON.stringify({metadata:{ideType:'IDE_UNSPECIFIED',platform:'PLATFORM_UNSPECIFIED',pluginType:'GEMINI'}}), signal:AbortSignal.timeout(20000)});
        const data = await plan.json().catch(() => ({}));
        const project = data.cloudaicompanionProject;
        if (typeof project === 'string') tokens.meta = {...tokens.meta, project};
        else if (project?.id) tokens.meta = {...tokens.meta, project: project.id};
        results.push({slot:slot+1, phase:'plan', status:plan.status, hasProject:Boolean(tokens.meta?.project), tier:data.currentTier?.id, reasons:data.error?.details?.map(d=>d.reason).filter(Boolean)});
        for (const model of ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']) {
          let hasText=false, completed=false;
          try {
            for await (const event of new GeminiCliProvider(tokens, model).chat({system:'Reply concisely.',messages:[{role:'user',content:[{type:'text',text:'Reply only OK.'}]}],tools:[],maxTokens:32,signal:AbortSignal.timeout(25000)})) {
              if(event.type==='text_delta' && event.text.trim()) hasText=true;
              if(event.type==='response') completed=true;
            }
            results.push({slot:slot+1,model,hasText,completed});
          } catch(error) {
            const message = String(error.message);
            const reason = /SERVICE_DISABLED|ACCESS_TOKEN_SCOPE_INSUFFICIENT|IAM_PERMISSION_DENIED|CONSUMER_INVALID|SECURITY_POLICY_VIOLATED/.exec(message)?.[0];
            results.push({slot:slot+1,model,status:error.status,hasText,completed,error: error.name,reason,
              permissionDenied:message.includes('PERMISSION_DENIED'),
              verificationRequired:/verify|verification/i.test(message),
              apiDisabled:/has not been used|disabled/i.test(message)});
          }
        }
      }
      return {time:new Date().toISOString(),results};
    }
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle, logLevel: 'silent' })
  await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
  await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ updates: { autoCheck: false } }))
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'anticode', main: 'main.cjs' }))
  await writeFile(path.join(profile, 'main.cjs'), "const {app}=require('electron'); globalThis.anticodeProbe=require('./probe.cjs'); app.setName('anticode'); app.whenReady().then(()=>{});")
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  app = await electron.launch({ args: [profile, `--user-data-dir=${profile}`], env, timeout: 20000 })
  console.error('Diagnostic app connected')
  const report = await app.evaluate(async ({ safeStorage }) => globalThis.anticodeProbe.run(safeStorage))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (app) await app.close()
  await rm(profile, { recursive: true, force: true })
}
