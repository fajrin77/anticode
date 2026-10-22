// Isolated profile and fixture network only. No real tokens or paid requests.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-composer-visibility-'))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({
  composerProviders: {},
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
async function launch() { return electron.launch({ args: [bootstrap], env, cwd: directory }) }
let app = await launch()
try {
  const page = await app.firstWindow()
  const custom = await page.evaluate(async () => {
    const next = await window.anticode.addProvider({label:'Fixture gateway',kind:'openai',baseURL:'https://fixture.invalid/v1',apiKey:'fixture',models:['fixture-model']})
    const custom = next.find(p=>p.label==='Fixture gateway')
    await window.anticode.setRotation([{provider:'auth:cline',model:'nvidia/nemotron-3.5-lightning:free'}, {provider:custom.id,model:'fixture-model'}])
    await window.anticode.selectProvider({provider:'auth:cline',model:'nvidia/nemotron-3.5-lightning:free'})
    return custom
  })
  await page.getByRole('button', { name: 'antichat', exact: true }).click()
  assert.equal(custom.composerVisible, false)
  const chip = () => page.getByRole('button', { name:'nvidia/nemotron-3.5-lightning:free', exact:true })
  await chip().click()
  await page.locator('[data-picker-empty]').filter({hasText:'No providers shown'}).waitFor()
  await page.keyboard.press('Escape')
  await page.getByTitle('Settings', {exact:true}).click()
  await page.getByRole('button',{name:'Providers',exact:true}).click()
  await page.getByRole('switch',{name:'Show Fixture gateway in composer',exact:true}).click()
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role="switch"]')).some(el=>el.getAttribute('aria-label')==='Show Fixture gateway in composer' && el.getAttribute('aria-checked')==='true'))
  await page.getByRole('button',{name:'Auth provider',exact:true}).click()
  await page.locator('[data-account-group="auth-cline"] button[aria-expanded]').click()
  const accountSwitch = page.locator('[data-composer-provider="auth:cline"]')
  await accountSwitch.click()
  await page.waitForFunction(()=>document.querySelector('[data-composer-provider="auth:cline"]')?.getAttribute('aria-checked')==='true')
  await page.screenshot({path:path.join(directory,'auth-composer-switch.png')})
  await page.getByRole('button',{name:/Back/}).click()
  await chip().click()
  await page.getByRole('button',{name:'Fixture gateway',exact:true}).waitFor()
  await page.getByRole('button',{name:'Cline Free',exact:true}).waitFor()
  await page.getByRole('button',{name:'Cline Free',exact:true}).click()
  await page.locator('[data-picker-model="nvidia/nemotron-3.5-lightning:free"]').waitFor()
  assert.equal(await page.locator('[data-picker-model="minimax/minimax-m3.1-flash:free"]').count(),0)
  await page.screenshot({path:path.join(directory,'composer-picked-only.png')})
  await page.keyboard.press('Escape')
  await page.getByTitle('Settings',{exact:true}).click()
  await page.getByRole('button',{name:'Auth provider',exact:true}).click()
  await page.locator('[data-account-group="auth-cline"] button[aria-expanded]').click()
  await page.locator('[data-composer-provider="auth:cline"]').click()
  await page.waitForFunction(()=>document.querySelector('[data-composer-provider="auth:cline"]')?.getAttribute('aria-checked')==='false')
  await page.getByRole('button',{name:/Back/}).click()
  await chip().click()
  await page.getByRole('button',{name:'fixture-model',exact:true}).waitFor()
  assert.equal(await page.locator('[data-picker-model="nvidia/nemotron-3.5-lightning:free"]').count(),0)
  assert.equal(await page.getByRole('button',{name:'Cline Free',exact:true}).count(),0)
  await app.close()
  app = await launch()
  const restarted = await app.firstWindow()
  const persisted = await restarted.evaluate(()=>window.anticode.listProviders())
  assert.equal(persisted.find(p=>p.id==='auth:cline').composerVisible,false)
  assert.equal(persisted.find(p=>p.id===custom.id).composerVisible,true)
  assert.equal(persisted.find(p=>p.id==='auth:cline').credentialAvailable,true)
  console.log('PASS: provider/account switches, hidden current provider, picked-only account models, empty state, persistent choices and intact credentials')
  console.log(JSON.stringify({directory}))
} finally { await app.close() }
