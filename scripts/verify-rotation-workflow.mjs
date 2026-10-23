// Real OAuth callbacks, IPC, account store and routing; all vendor responses are fixtures.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-rotation-workflow-'))
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const {app,shell}=require('electron');
const {writeFileSync}=require('node:fs');
const modelAccounts=[];
const clineAccounts=[];
app.setPath('userData',${JSON.stringify(directory)});
const realFetch=global.fetch;
const logins={codex:0,cline:0};
shell.openExternal=async value=>{
  const url=new URL(value);
  const kind=url.hostname==='api.cline.bot'?'cline':'codex';
  const index=Math.min(logins[kind]++,kind==='cline'?4:1);
  const callback=new URL(url.searchParams.get(kind==='cline'?'callback_url':'redirect_uri'));
  callback.searchParams.set('state',url.searchParams.get('state'));
  callback.searchParams.set('code',kind==='cline'?Buffer.from(JSON.stringify({accessToken:'fixture-cline-'+index,refreshToken:'refresh-cline-'+index,email:'cline'+index+'@example.test',expiresAt:Date.now()+3600000})).toString('base64url'):'fixture-code-'+index);
  await realFetch(callback);
};
global.fetch=async(input,options={})=>{
  const url=String(input);
  if(url.includes('auth.openai.com/oauth/token')){
    const body=typeof options.body==='string'?new URLSearchParams(options.body):options.body;
    const index=String(body.get('code')).endsWith('1')?1:0;
    const idToken='header.'+Buffer.from(JSON.stringify({email:'codex'+index+'@example.test','https://api.openai.com/auth':{chatgpt_account_id:'account-'+index}})).toString('base64url')+'.signature';
    return new Response(JSON.stringify({access_token:'fixture-codex-'+index,refresh_token:'refresh-codex-'+index,expires_in:3600,id_token:idToken}));
  }
  if(url.endsWith('/codex/responses')){
    modelAccounts.push(options.headers['chatgpt-account-id']);
    writeFileSync(${JSON.stringify(path.join(directory, 'model-accounts.json'))},JSON.stringify(modelAccounts));
    return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'OK'})+'\\n\\n'+'data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:10,output_tokens:2}}})+'\\n\\n');
  }
  if(url.endsWith('/chat/completions')) {
    const headers=new Headers(options.headers);
    const account=headers.get('authorization');
    writeFileSync(${JSON.stringify(path.join(directory, 'last-request.json'))},JSON.stringify({model:JSON.parse(options.body).model,account}));
    clineAccounts.push(account);
    writeFileSync(${JSON.stringify(path.join(directory, 'cline-model-accounts.json'))},JSON.stringify(clineAccounts));
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
  }
  if(url.includes('/codex/models?'))return new Response(JSON.stringify({models:[{slug:'gpt-6.1-sol'}]}));
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'deepseek/deepseek-v4.1-flash:free'},{id:'poolside/laguna-xs-2.1:free'},{id:'manual-fixture'}]}));
  if(url.endsWith('/recommended-models'))return new Response(JSON.stringify({free:[]}));
  throw Error('Unexpected fixture network request: '+url);
};
app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Auth provider', exact: true }).click()
  const cline = page.locator('[data-auth-vendor="cline"]')
  await cline.getByRole('button', { name: 'Sign in', exact: true }).click()
  await cline.getByText('1 account', { exact: true }).waitFor()
  await cline.getByRole('button', { name: 'Add account', exact: true }).click()
  await cline.getByText('2 accounts', { exact: true }).waitFor()
  const setup = await page.evaluate(async () => {
    const api = window.anticode
    await api.setProviderGroupVisibility('cline', true)
    const providers = await api.addProvider({ kind: 'openai', label: 'Manual fixture', baseURL: 'http://fixture.invalid/v1', apiKey: 'fixture-manual', models: ['manual-fixture'] })
    const provider = providers.find(item => item.label === 'Manual fixture').id
    await api.setProviderVisibility(provider, true)
    await api.setRotation([{ provider, model: 'manual-fixture' }])
    await api.setRotationEnabled(true)
    await api.createSession({ sessionId: 'unrelated', mode: 'chat', workspaceRoot: null })
    return { provider }
  })
  await page.getByRole('button', { name: 'Providers', exact: true }).click()
  const newGroup = async () => {
    await page.locator('[data-rotation-new-group]').click()
    const name = page.locator('input[value^="Group "]')
    await name.waitFor()
    await name.press('Enter')
    return page.evaluate(async () => (await window.anticode.getStatus()).rotationGroups.at(-1).id)
  }
  const serviceGroup = await newGroup()
  await page.locator('[data-rotation-add]').click()
  await page.locator('[data-rotation-bulk="service"][data-choice="auth:cline"]').waitFor()
  await page.screenshot({ path: path.join(directory, 'bulk-services.png') })
  await page.locator('[data-rotation-bulk="service"][data-choice="auth:cline"]').click()
  await page.waitForFunction(async id => (await window.anticode.getStatus()).rotationGroups.find(group => group.id === id)?.entries.length === 4, serviceGroup)
  console.log('PASS: one Cline click adds both accounts and both exact free model routes')
  const modelGroup = await newGroup()
  await page.locator('[data-rotation-add]').click()
  await page.getByRole('textbox', { name: 'Search services or models' }).fill('Deepseek 4.1 Flash')
  await page.locator('[data-rotation-bulk="model"]').waitFor()
  await page.screenshot({ path: path.join(directory, 'bulk-model-search.png') })
  await page.locator('[data-rotation-bulk="model"]').click()
  await page.waitForFunction(async id => (await window.anticode.getStatus()).rotationGroups.find(group => group.id === id)?.entries.length === 2, modelGroup)
  await page.locator('[data-rotation-add]').click()
  await page.getByRole('textbox', { name: 'Search services or models' }).fill('Deepseek 4.1 Flash')
  await page.locator('[data-rotation-bulk="model"]').click()
  await page.locator('[data-rotation-bulk-picker]').waitFor({ state: 'hidden' })
  const selected = await page.evaluate(async id => (await window.anticode.getStatus()).rotationGroups.find(group => group.id === id), modelGroup)
  assert.equal(selected.entries.length, 2)
  assert.ok(selected.entries.every(entry => entry.model === 'deepseek/deepseek-v4.1-flash:free' && entry.provider.startsWith('auth:cline')))
  console.log('PASS: model search adds every supported account, repeated selection deduplicates')
  await page.evaluate(id => window.anticode.selectRotationGroup(id), modelGroup)
  await page.getByTitle('Dashboard', { exact: true }).click()
  const modelChip = () => page.getByRole('button', { name: /^rotate/ })
  await modelChip().click()
  await page.locator(`[data-picker-provider="${setup.provider}"]`).click()
  await page.locator('[data-picker-model="manual-fixture"]').click()
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).waitFor()
  // Draft choice survives leaving and returning to the dashboard.
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByTitle('Dashboard', { exact: true }).click()
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).click()
  await page.locator('input[placeholder*="Search"]').fill('unknown-route-' + 'x'.repeat(300))
  await page.keyboard.press('Enter')
  await page.getByText('No matching configured model. Add a new id in Settings → Models first.').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).waitFor()
  console.log('PASS: unknown ids cannot replace the dashboard pick; the manual choice survives renderer restart')
  // Antichat avoids needing a project; send must pin the exact draft selection.
  await page.getByRole('button', { name: 'antichat', exact: true }).first().click()
  const prompt = page.locator('textarea').first()
  await prompt.fill('Respond briefly from the explicitly selected manual route.')
  await prompt.press('Enter')
  await page.waitForFunction(async provider => Object.entries((await window.anticode.getStatus()).sessions).some(([id, session]) => id !== 'unrelated' && session.provider === provider && session.model === 'manual-fixture'), setup.provider)
  await page.getByText('OK', { exact: true }).waitFor()
  const request = JSON.parse(await readFile(path.join(directory, 'last-request.json'), 'utf8'))
  assert.equal(request.model, 'manual-fixture')
  assert.match(request.account, /fixture-manual/)
  assert.equal(await page.evaluate(async () => (await window.anticode.getStatus()).sessions.unrelated.provider), 'rotate')
  console.log('PASS: dashboard manual choice is used by the first actual SDK request; unrelated session stays Rotate')
  await page.getByTitle('Dashboard', { exact: true }).click()
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).click()
  await page.locator('[data-picker-provider="rotate"]').click()
  await page.keyboard.press('Escape')
  await modelChip().waitFor()
  await page.screenshot({ path: path.join(directory, 'dashboard-rotate.png') })
  console.log('PASS: dashboard can return to Rotate')
  await page.evaluate(() => window.anticode.setRotationGroups([]))
  await modelChip().click()
  await page.locator(`[data-picker-provider="${setup.provider}"]`).click()
  await page.locator('[data-picker-model="manual-fixture"]').click()
  await page.getByRole('button', { name: 'manual-fixture', exact: true }).waitFor()
  console.log('PASS: dashboard remains switchable when Rotate has no saved groups')
  console.log(JSON.stringify({ directory }))
} catch (error) {
  const page = app.windows()[0]
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
  if (page) console.error(await page.locator('body').innerText())
  throw error
} finally { await app.close() }
