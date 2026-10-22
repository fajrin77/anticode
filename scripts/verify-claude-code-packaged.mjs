// Explicit live test of packaged Anticode with a copied, encrypted Claude account.
// Only an isolated workspace/profile is changed. This spends a little plan usage.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-claude-packaged-live-'))
const profile = path.join(directory, 'profile'), workspace = path.join(directory, 'workspace')
await Promise.all([mkdir(profile), mkdir(workspace)])
const saved = JSON.parse(await readFile(path.join(homedir(), 'Library/Application Support/anticode/auth-accounts.json'), 'utf8'))
const row = saved.accounts.find(r => r.account.kind === 'claude')
if (!row) throw new Error('No Claude account in Anticode')
await writeFile(path.join(profile, 'auth-accounts.json'), JSON.stringify({ version: 1, accounts: [row] }), { mode: 0o600 })
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false }, composerProviders: { [row.account.id]: true } }))
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ executablePath: path.resolve('release/mac-arm64/anticode.app/Contents/MacOS/anticode'), args: [`--user-data-dir=${profile}`], env })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const selected = process.argv.slice(2).filter(arg => arg.startsWith('claude-'))
  for (const [index, model] of (selected.length ? selected : ['claude-sonnet-5-5', 'claude-opus-5-5']).entries()) {
    const filename = `native-${index}.txt`
    const result = await page.evaluate(async ({ workspace, provider, model, filename, index }) => {
      const api = window.anticode, sessionId = `native-claude-${index}`
      await api.setAutoApprove(true)
      await api.createSession({ sessionId, mode: 'code', workspaceRoot: workspace })
      await api.selectProvider({ provider, model }, sessionId)
      const done = new Promise((resolve, reject) => {
        let text = false, tools = 0
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('Packaged live test timed out')) }, 120000)
        const unsubscribe = api.onAgentEvent(event => {
          if (event.sessionId !== sessionId) return
          if (event.type === 'text_delta') text = true
          if (event.type === 'tool_start') tools++
          if (event.type === 'error') { clearTimeout(timer); unsubscribe(); reject(new Error(event.message)) }
          if (event.type === 'end') { clearTimeout(timer); unsubscribe(); resolve({ text, tools }) }
        })
      })
      await api.sendPrompt({ sessionId, runId: `native-run-${index}`, prompt: `Use apply_patch to create ${filename} containing exactly count=42 followed by a newline. Then read it back using read_file and reply only VERIFIED.`, attachmentIds: [] })
      return await done
    }, { workspace, provider: row.account.id, model, filename, index })
    assert.equal(await readFile(path.join(workspace, filename), 'utf8'), 'count=42\n')
    console.log(JSON.stringify({ evidence: 'live-packaged-app', model, fileCreated: true, ...result }))
  }
  console.log(JSON.stringify({ status: 'passed', directory }))
} finally { await app.close() }
