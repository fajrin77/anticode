// Isolated desktop verification. All provider fetches are intercepted in the
// Electron main process; this never signs in or spends real subscription/API usage.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-native-subscriptions-'))
const profile = path.join(directory, 'profile')
const workspace = path.join(directory, 'workspace')
await Promise.all([mkdir(profile), mkdir(workspace)])
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const { app, safeStorage } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(profile)});
app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Test requires secure storage');
  const accounts = ['auth:codex', 'auth:codex-2'].map((id, index) => ({
    account: { id, kind: 'codex', label: 'Fixture ChatGPT ' + (index + 1), createdAt: Date.now(), refreshable: true },
    sealed: 'safe:v1:' + safeStorage.encryptString(JSON.stringify({ accessToken: 'fixture-' + index, refreshToken: 'refresh-' + index, expiresAt: Date.now() + 7200000, meta: { accountId: 'account-' + index } })).toString('base64')
  }));
  writeFileSync(${JSON.stringify(path.join(profile, 'auth-accounts.json'))}, JSON.stringify({ version: 1, accounts }));
  const calls = [];
  let replies = 0;
  global.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes('/codex/models?')) return new Response(JSON.stringify({ models: [{ slug: 'gpt-6.1-fixture-only' }, { slug: 'gpt-6-fixture' }] }));
    if (url.endsWith('/wham/usage')) return new Response(JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }));
    if (!url.endsWith('/codex/responses')) throw new Error('Unexpected network fetch: ' + url);
    const account = options.headers['chatgpt-account-id'];
    const body = JSON.parse(options.body);
    calls.push({ url, account, model: body.model, tools: body.tools.map(tool => tool.name) });
    writeFileSync(${JSON.stringify(path.join(directory, 'requests.json'))}, JSON.stringify(calls));
    if (account === 'account-0') return new Response(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 3600 } }), { status: 429 });
    const event = replies++ === 0
      ? { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'patch-1', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\\n*** Add File: native.txt\\n+native subscription routing\\n*** End Patch' }) } }
      : { type: 'response.output_text.delta', delta: 'Native routing verified.' };
    const completed = { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 2 } } };
    return new Response('data: ' + JSON.stringify(event) + '\\n\\ndata: ' + JSON.stringify(completed) + '\\n\\n');
  };
  await import(${JSON.stringify(path.resolve('out/main/index.js'))});
});
`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Auth provider', exact: true }).click()
  const routing = page.getByRole('switch', { name: 'Subscription routing', exact: true })
  await routing.click()
  await page.waitForFunction(() => document.querySelector('[aria-label="Subscription routing"]')?.getAttribute('aria-checked') === 'true')
  await page.getByRole('button', { name: 'Refresh ChatGPT quota', exact: true }).click()
  await page.getByText('Primary window: 25% used', { exact: false }).first().waitFor()
  await page.screenshot({ path: path.join(directory, 'native-routing.png') })
  const result = await page.evaluate(async (workspace) => {
    const api = window.anticode
    await api.setAutoApprove(true)
    await api.createSession({ sessionId: 'native-test', mode: 'code', workspaceRoot: workspace })
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Native run timed out')) }, 15000)
      const unsubscribe = api.onAgentEvent((event) => {
        if (event.sessionId !== 'native-test') return
        if (event.type === 'error') { clearTimeout(timer); unsubscribe(); reject(new Error(event.message)) }
        if (event.type === 'end') { clearTimeout(timer); unsubscribe(); resolve(event) }
      })
    })
    await api.sendPrompt({ sessionId: 'native-test', runId: 'native-run', prompt: 'Create native.txt', attachmentIds: [] })
    await done
    return { status: await api.getStatus(), usage: await api.getUsageSummary(null) }
  }, workspace)
  assert.equal(await readFile(path.join(workspace, 'native.txt'), 'utf8'), 'native subscription routing\n')
  const calls = JSON.parse(await readFile(path.join(directory, 'requests.json'), 'utf8'))
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(call => call.account), ['account-0', 'account-1', 'account-1'])
  assert.ok(calls.every(call => call.url === 'https://chatgpt.com/backend-api/codex/responses'))
  assert.ok(calls.every(call => call.tools.includes('apply_patch')))
  assert.equal(result.status.subscriptionOnly, true)
  assert.equal(result.usage.requests, 2)
  assert.equal(result.usage.inputTokens, 22)
  assert.equal(result.usage.costPartial, true)
  // The composer follows the models explicitly enabled by the user (0.0.59).
  await page.evaluate(async () => {
    await window.anticode.setSubscriptionRouting(false)
    await window.anticode.setRotation([{ provider: 'auth:codex-2', model: 'gpt-6.1-sol' }])
    await window.anticode.selectProvider({ provider: 'auth:codex-2', model: 'gpt-6.1-sol' })
  })
  await page.getByTitle('Dashboard', { exact: true }).click()
  await page.getByRole('button', { name: 'antichat', exact: true }).click()
  await page.getByRole('button', { name: 'gpt-6.1-sol', exact: true }).click()
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.5']) {
    assert.equal(await page.locator('[data-picker-model="' + model + '"]').count(), 0)
  }
  await page.screenshot({ path: path.join(directory, 'models-full.png') })
  await page.evaluate(() => window.anticode.setSubscriptionRouting(true))
  console.log('PASS: OAuth composer respects explicitly selected models')
  console.log(JSON.stringify({ status: 'passed', directory, directRequests: calls.length, usage: result.usage.requests }))
} finally { await app.close() }

// Start again with the same isolated profile. Fixture model ids intentionally
// differ from the built-in fallback list, so readiness proves catalogue persistence.
const restarted = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await restarted.firstWindow()
  const status = await page.evaluate(() => window.anticode.getStatus())
  assert.equal(status.subscriptionOnly, true)
  assert.equal(status.providerReady, true)
  assert.ok(status.rotation.some(entry => entry.ready && entry.model === 'gpt-6.1-fixture-only'))
  console.log('PASS: native subscription routing and observed model catalogue survive restart')
} finally { await restarted.close() }
