// Isolated profile and fixture network only. No real tokens or paid requests.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-cline-free-'))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
  composerProviders: { 'auth:cline': true },
  authModelCatalogues: { 'auth:cline': { models: ['anthropic/claude-sonnet-4.6'], checkedAt: 1 } },
  rotation: { entries: [{ provider: 'auth:cline', model: 'anthropic/claude-sonnet-4.6' }], usage: {} }
}))
await writeFile(bootstrap, `
const { app, safeStorage } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(directory)});
app.whenReady().then(async () => {
  writeFileSync(${JSON.stringify(path.join(directory, 'auth-accounts.json'))}, JSON.stringify({version:1,accounts:[{
    account:{id:'auth:cline',kind:'cline',label:'Cline',createdAt:Date.now(),refreshable:false},
    sealed:'safe:v1:'+safeStorage.encryptString(JSON.stringify({accessToken:'fixture',expiresAt:Date.now()+3600000})).toString('base64')
  }]}));
  global.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/models')) return new Response(JSON.stringify({data:[{id:'anthropic/claude-sonnet-4.6'},{id:'nvidia/nemotron-3.5-lightning:free'},{id:'minimax/minimax-m3.1-flash:free'},{id:'nvidia/nemotron-3.5-super-vl:free'}]}));
    if (url.endsWith('/recommended-models')) return new Response(JSON.stringify({free:[{id:'cline-free/muse-spark-1.3-contributor'},{id:'cline-free/minimax-m3.1-flash'},{id:'cline-free/nemotron-3.5-super-vl'}],recommended:[{id:'paid/model'}]}));
    throw new Error('Unexpected request: '+url);
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
  const models = await page.evaluate(async () => {
    const catalogue = await window.anticode.listModels('auth:cline', true)
    await window.anticode.setRotation([{provider:'auth:cline',model:'nvidia/nemotron-3.5-lightning:free'},{provider:'auth:cline',model:'cline-free/muse-spark-1.3-contributor'}])
    await window.anticode.selectProvider({ provider: 'auth:cline', model: 'nvidia/nemotron-3.5-lightning:free' })
    return catalogue.models
  })
  assert.ok(models.includes('nvidia/nemotron-3.5-lightning:free'))
  assert.ok(models.includes('cline-free/muse-spark-1.3-contributor'))
  assert.ok(!models.includes('anthropic/claude-sonnet-4.6'))
  assert.ok(models.includes('minimax/minimax-m3.1-flash:free'))
  assert.ok(models.includes('nvidia/nemotron-3.5-super-vl:free'))
  assert.ok(!models.includes('cline-free/minimax-m3.1-flash'))
  assert.ok(!models.includes('cline-free/nemotron-3.5-super-vl'))
  await page.getByRole('button', { name: 'antichat', exact: true }).click()
  await page.getByRole('button', { name: 'nvidia/nemotron-3.5-lightning:free', exact: true }).click()
  await page.getByRole('button', { name: 'cline-free/muse-spark-1.3-contributor free', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'anthropic/claude-sonnet-4.6', exact: true }).count(), 0)
  await page.screenshot({ path: path.join(directory, 'cline-free.png') })
  await page.keyboard.press('Escape')
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.locator('[data-model-name="nvidia/nemotron-3.5-lightning:free"]').waitFor()
  assert.equal(await page.locator('[data-model-name="anthropic/claude-sonnet-4.6"]').count(), 0)
  const status = await page.evaluate(() => window.anticode.setSubscriptionRouting(true))
  assert.ok(status.rotation.some(entry => entry.provider === 'auth:cline' && entry.model === 'nvidia/nemotron-3.5-lightning:free' && entry.ready))
  console.log('PASS: Cline free catalogue, picker, legacy paid filtering and native routing')
  console.log(JSON.stringify({ directory, models: models.length }))
} finally { await app.close() }
