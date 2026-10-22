// Fixture only: public login contracts, real IPC, catalogue filtering and sealed storage.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-free-auth-'))
const profile = path.join(directory, 'profile')
await mkdir(profile)
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const { app, shell } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});

shell.openExternal = async address => {
  const url = new URL(address);

};
global.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.endsWith('/auth/keys')) {
    const body = JSON.parse(options.body);
    if (body.code !== 'fixture-code' || !body.code_verifier) throw new Error('Missing PKCE');
    return Response.json({ key: 'fixture-openrouter-key', user_id: 'fixture-user' });
  }
  if (url === 'https://api.kilo.ai/api/device-auth/codes') return Response.json({ code: 'fixture-device', verificationUrl: 'https://kilo.ai/device-auth?code=fixture-device', expiresIn: 300 });
  if (url.endsWith('/codes/fixture-device')) return Response.json({ status: 'approved', token: 'fixture-kilo-key', userEmail: 'kilo@example.test' });
  if (url.endsWith('/token_plan/remains')) return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: 'MiniMax-M3' }, { model_name: 'wallet-model' }] });
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'paid/model' }, { id: 'free/model:free' }] });
  throw new Error('Unexpected fixture request: ' + url);
};
app.whenReady().then(() => import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Auth provider', exact: true }).click()
  for (const kind of ['openrouter', 'kilo']) {
    await page.locator(`[data-auth-vendor="${kind}"]`).getByRole('button', { name: 'Sign in', exact: true }).click()
    if (kind === 'openrouter') {
      await page.getByLabel('OpenRouter authorization code', { exact: true }).fill('fixture-code')
      await page.getByRole('button', { name: 'Submit', exact: true }).click()
    }
    await page.waitForFunction(async kind => (await window.anticode.listAuthAccounts()).some(account => account.kind === kind), kind)
  }
  await page.locator('[data-auth-vendor="minimax-plan"]').getByRole('button', { name: 'Connect key', exact: true }).click()
  const input = page.locator('input[aria-label="MiniMax Token Plan sk-cp key"]')
  await input.waitFor()
  assert.equal(await input.getAttribute('type'), 'password')
  await input.fill('sk-cp-fixture-plan')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.waitForFunction(async () => (await window.anticode.listAuthAccounts()).length === 3)
  const results = await page.evaluate(async () => {
    const providers = await window.anticode.listProviders()
    const selected = providers.filter(provider => ['kilo', 'openrouter', 'minimax-plan'].includes(provider.authKind))
    return Promise.all(selected.map(async provider => ({ kind: provider.authKind, billing: provider.billing, models: (await window.anticode.listModels(provider.id, true)).models })))
  })
  assert.equal(results.length, 3)
  for (const result of results) {
    assert.equal(result.billing, result.kind === 'minimax-plan' ? 'subscription' : 'free')
    assert.deepEqual(result.models, result.kind === 'minimax-plan' ? ['MiniMax-M3'] : ['free/model:free'])
  }
  const saved = await readFile(path.join(profile, 'auth-accounts.json'), 'utf8')
  for (const secret of ['fixture-openrouter-key', 'fixture-kilo-key', 'sk-cp-fixture-plan']) assert.ok(!saved.includes(secret))
  await page.screenshot({ path: path.join(directory, 'auth.png') })
  console.log(JSON.stringify({ status: 'passed', evidence: 'fixture', directory, checks: ['OpenRouter PKCE display code via UI', 'Kilo device approval', 'MiniMax masked plan input', 'free/plan catalogue guards', 'secure storage'] }))
} finally { await app.close() }
