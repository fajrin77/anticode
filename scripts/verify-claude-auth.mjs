// Fixture only: no browser login or provider usage. Exercises the actual Electron IPC and SDK.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-claude-auth-'))
const profile = path.join(directory, 'profile')
await mkdir(profile)
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const { app, shell } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
shell.openExternal = async url => { global.claudeAuthorize = url };
global.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url === 'https://api.anthropic.com/v1/oauth/token') {
    const body = JSON.parse(options.body);
    const state = new URL(global.claudeAuthorize).searchParams.get('state');
    if (body.code !== 'fixture-code' || body.state !== state || !body.code_verifier) throw new Error('Wrong PKCE exchange');
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, account: { uuid: 'fixture-user', email_address: 'fixture@example.com' }, organization: { uuid: 'fixture-org' } });
  }
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'paid/model' }, { id: 'free/model:free' }, { id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4.1-flash-free' }] });
  throw new Error('Unexpected fixture request: ' + url);
};
require('electron').app.whenReady().then(() => import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Auth provider', exact: true }).click()
  await page.locator('[data-auth-vendor="claude"]').getByRole('button', { name: 'Sign in', exact: true }).click()
  // Password inputs have no implicit textbox role.
  const input = page.locator('input[aria-label="Claude code#state or callback URL"]')
  await input.waitFor()
  assert.equal(await input.getAttribute('type'), 'password')
  const state = await app.evaluate(() => new URL(global.claudeAuthorize).searchParams.get('state'))
  await input.fill('fixture-code#' + state)
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  await page.getByText('fixture@example.com', { exact: false }).first().waitFor()
  const accounts = await page.evaluate(() => window.anticode.listAuthAccounts())
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].kind, 'claude')
  const saved = await readFile(path.join(profile, 'auth-accounts.json'), 'utf8')
  assert.ok(!saved.includes('fixture-access') && !saved.includes('fixture-refresh'))
  await page.getByRole('button', { name: 'Providers', exact: true }).click()
  await page.getByRole('button', { name: '+ Add provider', exact: true }).click()
  await page.getByLabel('Provider connection', { exact: true }).selectOption('opencode-free')
  await page.getByText('Free routes only;', { exact: false }).waitFor()
  const added = await page.evaluate(async () => {
    const next = await window.anticode.addProvider({ preset: 'opencode-free', label: 'OpenCode Free', kind: 'openai', baseURL: 'https://opencode.ai/zen/v1', apiKey: 'fixture-key', models: ['deepseek-v4.1-flash-free'] })
    const provider = next.find(p => p.preset === 'opencode-free')
    return { provider, models: await window.anticode.listModels(provider.id) }
  })
  assert.equal(added.provider.billing, 'free')
  assert.equal(added.models.error, null)
  assert.deepEqual(added.models.models, ['deepseek-v4.1-flash-free'])
  await assert.rejects(page.evaluate(async id => window.anticode.updateProvider(id, { models: ['deepseek-v4.1-flash'] }), added.provider.id), /free model routes only/)
  await page.getByLabel('Provider connection', { exact: true }).selectOption('kilo-free')
  assert.equal(await page.getByRole('button', { name: 'Add provider', exact: true }).isEnabled(), true)
  const anonymous = await page.evaluate(async () => {
    const providers = await window.anticode.addProvider({ preset: 'kilo-free', label: 'Kilo Gateway Free', kind: 'openai', baseURL: 'https://ai-gateway.kilo.ai/api/v1', apiKey: '' })
    return providers.find(provider => provider.preset === 'kilo-free')
  })
  assert.equal(anonymous.credentialAvailable, true)
  assert.equal(anonymous.hasKey, false)
  assert.equal(anonymous.billing, 'free')
  console.log(JSON.stringify({ status: 'passed', evidence: 'fixture', directory, checks: ['Claude code#state UI and PKCE exchange', 'sealed tokens', 'free connection UI', 'catalogue filters paid ids', 'edit rejects paid alias'] }))
} finally { await app.close() }
