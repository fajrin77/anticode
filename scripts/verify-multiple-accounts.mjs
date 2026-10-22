// Real OAuth callbacks, IPC, account store and routing; all vendor responses are fixtures.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-multiple-accounts-'))
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
    clineAccounts.push(account);
    writeFileSync(${JSON.stringify(path.join(directory, 'cline-model-accounts.json'))},JSON.stringify(clineAccounts));
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
  }
  if(url.includes('/codex/models?'))return new Response(JSON.stringify({models:[{slug:'gpt-6.1-sol'}]}));
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'nvidia/nemotron-3.5-lightning:free'}]}));
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
  const codex = page.locator('[data-auth-vendor="codex"]')
  await codex.getByRole('button', { name: 'Sign in', exact: true }).click()
  await codex.getByText('1 account', { exact: true }).waitFor()
  await page.getByRole('switch', { name: 'Subscription routing', exact: true }).click()
  await codex.getByRole('button', { name: 'Add account', exact: true }).click()
  await codex.getByText('2 accounts', { exact: true }).waitFor()
  const cline = page.locator('[data-auth-vendor="cline"]')
  await cline.getByRole('button', { name: 'Sign in', exact: true }).click()
  await cline.getByText('1 account', { exact: true }).waitFor()
  for (let count=2;count<=5;count++) {
    await cline.getByRole('button', { name: 'Add account', exact: true }).click()
    await cline.getByText(`${count} accounts`, { exact: true }).waitFor()
  }
  await cline.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByText('Account reconnected', { exact: true }).waitFor()
  await page.evaluate(async () => {
    await window.anticode.setProviderGroupVisibility('codex', true)
    await window.anticode.setProviderGroupVisibility('cline', true)
  })
  const result = await page.evaluate(async () => ({ accounts: await window.anticode.listAuthAccounts(), status: await window.anticode.getStatus() }))
  assert.equal(result.accounts.length, 7)
  for (const id of ['auth:codex', 'auth:codex-2', 'auth:cline', 'auth:cline-2', 'auth:cline-3', 'auth:cline-4', 'auth:cline-5']) {
    assert.ok(result.accounts.some(row => row.id === id && row.usable))
    assert.ok(result.status.rotation.some(entry => entry.provider === id && entry.ready))
  }
  await page.evaluate(async () => {
    const api = window.anticode
    await api.createSession({ sessionId: 'account-balance', mode: 'chat', workspaceRoot: null })
    for (let index=0; index<4; index++) {
      const done = new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{off();reject(Error('Balance run timeout'))},15000)
        const off=api.onAgentEvent(event=>{
          if(event.sessionId!=='account-balance')return
          if(event.type==='error'){clearTimeout(timer);off();reject(Error(event.message))}
          if(event.type==='end'){clearTimeout(timer);off();resolve(event)}
        })
      })
      await api.sendPrompt({ sessionId:'account-balance',runId:'balance-'+index,prompt:'Reply OK only.',attachmentIds:[] })
      await done
    }
  })
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'model-accounts.json'),'utf8')), ['account-0','account-0','account-1','account-1'])
  console.log('PASS: four prompts split across separate ChatGPT accounts, two requests per account')
  await page.evaluate(async () => {
    const api=window.anticode;
    await api.setRotationEnabled(false);
    await api.setProviderVisibility('auth:codex',true);
    await api.setProviderGroupVisibility('cline',true);
    await api.createSession({sessionId:'cline-balance',mode:'chat',workspaceRoot:null});
    await api.selectProvider({provider:'auth:cline',model:'nvidia/nemotron-3.5-lightning:free'},'cline-balance');
    for(let index=0;index<25;index++) {
      const done=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{off();reject(Error('Cline balance timeout'))},15000);
        const off=api.onAgentEvent(event=>{
          if(event.sessionId!=='cline-balance')return;
          if(event.type==='error'){clearTimeout(timer);off();reject(Error(event.message))}
          if(event.type==='end'){clearTimeout(timer);off();resolve(event)}
        });
      });
      await api.sendPrompt({sessionId:'cline-balance',runId:'cline-balance-'+index,prompt:'Reply OK only.',attachmentIds:[]});
      await done;
    }
  });
  const clineCalls=JSON.parse(await readFile(path.join(directory,'cline-model-accounts.json'),'utf8'));
  assert.equal(clineCalls.length,25);
  assert.equal(new Set(clineCalls.slice(0,5)).size,5);
  for(let index=0;index<5;index++) assert.equal(clineCalls.filter(key=>key===`Bearer fixture-cline-${index}`).length,5);
  console.log('PASS: one selected Cline model shares 25 prompts evenly across five accounts with model rotation disabled');
  const master = cline.locator('[data-composer-group="cline"]')
  await master.waitFor()
  assert.equal(await master.getAttribute('aria-checked'), 'true')
  await cline.locator('[data-composer-provider="auth:cline"]').click()
  await page.waitForFunction(() => document.querySelector('[data-composer-group="cline"]')?.getAttribute('aria-checked') === 'mixed')
  await page.evaluate(async () => {
    const api = window.anticode
    for (let index = 0; index < 4; index++) {
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(Error('Disabled account test timeout')) }, 15000)
        const off = api.onAgentEvent(event => {
          if (event.sessionId !== 'cline-balance') return
          if (event.type === 'error') { clearTimeout(timer); off(); reject(Error(event.message)) }
          if (event.type === 'end') { clearTimeout(timer); off(); resolve(event) }
        })
      })
      await api.sendPrompt({ sessionId: 'cline-balance', runId: 'disabled-'+index, prompt: 'Reply OK only.', attachmentIds: [] })
      await done
    }
  })
  const afterDisable = JSON.parse(await readFile(path.join(directory, 'cline-model-accounts.json'), 'utf8')).slice(25)
  assert.equal(afterDisable.length, 4)
  assert.ok(afterDisable.every(key => key !== 'Bearer fixture-cline-0'))
  await master.click()
  await page.waitForFunction(() => document.querySelector('[data-composer-group="cline"]')?.getAttribute('aria-checked') === 'true')
  await master.click()
  await page.waitForFunction(() => document.querySelector('[data-composer-group="cline"]')?.getAttribute('aria-checked') === 'false')
  assert.ok((await page.evaluate(() => window.anticode.listProviders())).filter(p => p.authKind === 'cline').every(p => !p.composerVisible))
  await master.click()
  await page.waitForFunction(() => document.querySelector('[data-composer-group="cline"]')?.getAttribute('aria-checked') === 'true')
  await page.screenshot({path:path.join(directory,'composer-group-and-accounts.png')})
  console.log('PASS: group master enables/disables all accounts; individual override shows mixed state and excludes the disabled account from subsequent prompts')
  await page.getByRole('button',{name:/Back/}).click()
  await page.getByRole('button',{name:'nvidia/nemotron-3.5-lightning:free',exact:true}).click()
  assert.equal(await page.locator('[data-picker-provider^="auth:cline"]').count(),1)
  assert.equal(await page.locator('[data-picker-model="nvidia/nemotron-3.5-lightning:free"]').count(),1)
  await page.getByRole('button',{name:'Cline Free · 5 accounts',exact:true}).waitFor()
  await page.screenshot({path:path.join(directory,'one-cline-tab-five-accounts.png')})
  await page.keyboard.press('Escape')
  await page.evaluate(()=>window.anticode.setSubscriptionRouting(true))
  console.log('PASS: five Cline accounts appear as one provider tab and one copy of each selected model')

  const stored = await readFile(path.join(directory, 'auth-accounts.json'), 'utf8')
  assert.ok(!stored.includes('fixture-cline-'))
  assert.ok(!stored.includes('fixture-codex-'))
  await page.screenshot({ path: path.join(directory, 'accounts.png') })
  console.log('PASS: two ChatGPT and five Cline accounts through browser callbacks; duplicate reconnect creates no extra account; new logins join active routing')
} finally { await app.close() }
const restarted = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await restarted.firstWindow()
  const result = await page.evaluate(async () => ({ accounts: await window.anticode.listAuthAccounts(), status: await window.anticode.getStatus() }))
  assert.equal(result.accounts.length, 7)
  assert.ok(result.accounts.every(account => account.usable))
  assert.equal(result.status.subscriptionOnly, true)
  for (const account of result.accounts) assert.ok(result.status.rotation.some(entry => entry.provider === account.id && entry.ready))
  console.log('PASS: independent accounts and active routing survive restart')
  console.log(JSON.stringify({ directory }))
} finally { await restarted.close() }
