// Isolated profile: real IPC, secure store, browser callback and inference SDK; vendor responses are fixtures.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const dir = await mkdtemp(path.join(tmpdir(), 'anticode-pass-auth-'))
await writeFile(path.join(dir,'settings.json'),JSON.stringify({provider:'clinepass',model:'cline-pass/test',composerProviders:{clinepass:true},remote:{enabled:false},updates:{autoCheck:false},rotation:{entries:[{provider:'clinepass',model:'cline-pass/test'}],usage:{}}}))
const bootstrap=path.join(dir,'bootstrap.cjs')
await writeFile(bootstrap,`
const {app,safeStorage,shell}=require('electron'); const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(dir)});
const realFetch=global.fetch; let callbackCount=0; let inferenceCount=0;
shell.openExternal=async value=>{
 const url=new URL(value);const callback=new URL(url.searchParams.get('callback_url'));
 callback.searchParams.set('state',url.searchParams.get('state'));
 callback.searchParams.set('code',Buffer.from(JSON.stringify({accessToken:'fixture-pass-oauth',refreshToken:'fixture-pass-refresh',email:'pass@example.test',expiresAt:Date.now()+3600000})).toString('base64url'));
 callbackCount++;await realFetch(callback);
};
global.fetch=async(input,options={})=>{
 const url=String(input);
 if(url.endsWith('/users/me/plan/usage-limits'))return Response.json({success:true,data:{limits:[{type:'five_hour',percentUsed:17,resetsAt:new Date(Date.now()+12540000).toISOString()},{type:'weekly',percentUsed:34,resetsAt:'2026-10-25T08:21:02Z'},{type:'monthly',percentUsed:17,resetsAt:'2026-11-17T08:21:02Z'}]}});
 if(url.endsWith('/users/me/plan'))return Response.json({success:true,data:{subscriptionId:'fixture-subscription',plan:{isActive:true,entitlements:{cline_pass:{enabled:true}}}}});
 if(url.endsWith('/chat/completions')){
  const model=JSON.parse(options.body).model;if(model!=='cline-pass/test')throw Error('Unexpected model');
  inferenceCount++;fs.writeFileSync(${JSON.stringify(path.join(dir,'calls.json'))},JSON.stringify({inferenceCount,callbackCount}));
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 }
 if(url.endsWith('/recommended-models'))return Response.json({free:[]});
 if(url.endsWith('/models'))return Response.json({data:[{id:'cline-pass/test'},{id:'paid/model'},{id:'free/model:free'}]});
 throw Error('Unexpected fixture request');
};
app.whenReady().then(()=>{
 fs.writeFileSync(${JSON.stringify(path.join(dir,'providers.json'))},JSON.stringify({providers:[{id:'clinepass',label:'Clinepass',kind:'openai',baseURL:'https://api.cline.bot/api/v1',apiKey:'safe:v1:'+safeStorage.encryptString('fixture-pass-key').toString('base64'),models:['cline-pass/test']}],builtin:{clinepass:{removed:true}}}));
 fs.writeFileSync(${JSON.stringify(path.join(dir,'auth-accounts.json'))},JSON.stringify({version:1,accounts:Array.from({length:5},(_,i)=>({account:{id:'auth:cline'+(i?'-'+(i+1):''),kind:'cline',label:'Cline · free'+i,createdAt:1,refreshable:false},sealed:'safe:v1:'+safeStorage.encryptString(JSON.stringify({accessToken:'fixture-free-'+i,expiresAt:0})).toString('base64')}))}));
 return import(${JSON.stringify(path.resolve('out/main/index.js'))});
});
`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const app=await electron.launch({args:[bootstrap],env})
try {
 const page=await app.firstWindow()
 const initial=await page.evaluate(async()=>({providers:await window.anticode.listProviders(),accounts:await window.anticode.listAuthAccounts(),status:await window.anticode.getStatus()}))
 assert.equal(initial.accounts.filter(a=>a.kind==='cline').length,5)
 assert.equal(initial.accounts.filter(a=>a.kind==='clinepass').length,1)
 assert.equal(initial.providers.find(p=>p.id==='clinepass').kind,'auth')
 assert.equal(initial.providers.find(p=>p.id==='clinepass').composerVisible,true)
 assert.equal(initial.status.provider,'clinepass')
 await page.getByTitle('Settings',{exact:true}).click()
 await page.getByRole('button',{name:'Auth provider',exact:true}).click()
 const free=page.locator('[data-auth-vendor="cline"]')
 const pass=page.locator('[data-auth-vendor="clinepass"]')
 await free.getByText('Cline Free',{exact:true}).waitFor()
 await free.getByText('5 accounts',{exact:true}).waitFor()
 await pass.getByText('ClinePass',{exact:true}).first().waitFor()
 await pass.getByText('1 account',{exact:true}).waitFor()
 await page.screenshot({path:path.join(dir,'separate-auth-groups.png')})
 // Browser identity must reconnect the imported plan key instead of creating a second quota slot.
 await pass.getByRole('button',{name:'Add account',exact:true}).click()
 await page.getByText('Account reconnected',{exact:true}).waitFor()
 assert.equal((await page.evaluate(()=>window.anticode.listAuthAccounts())).length,6)
 const quotas=await page.evaluate(()=>window.anticode.getSubscriptionQuotas())
 assert.deepEqual(quotas.find(q=>q.provider==='clinepass').windows.map(w=>w.usedPercent),[17,34,17])
 await page.getByRole('button',{name:'Usage',exact:true}).click()
 await page.getByText('ClinePass',{exact:true}).first().waitFor()
 const usageGroup=page.locator('[data-quota-group="clinepass"]')
 if(await usageGroup.count() && !(await usageGroup.evaluate(el=>el.open)))await usageGroup.locator('summary').click()
 await page.getByText('34%',{exact:true}).waitFor()
 await page.screenshot({path:path.join(dir,'clinepass-quota-windows.png')})
 await page.evaluate(async()=>{
  const api=window.anticode
  await api.createSession({sessionId:'pass-check',mode:'chat',workspaceRoot:null})
  await api.selectProvider({provider:'clinepass',model:'cline-pass/test'},'pass-check')
  const done=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{off();reject(Error('Prompt timeout'))},15000)
   const off=api.onAgentEvent(e=>{if(e.sessionId!=='pass-check')return;if(e.type==='error'){clearTimeout(timer);off();reject(Error(e.message))}if(e.type==='end'){clearTimeout(timer);off();resolve()}})
  })
  await api.sendPrompt({sessionId:'pass-check',runId:'fixture-pass',prompt:'Reply OK',attachmentIds:[]});await done
 })
 assert.equal(JSON.parse(await readFile(path.join(dir,'calls.json'),'utf8')).inferenceCount,1)
 assert.ok(!(await readFile(path.join(dir,'auth-accounts.json'),'utf8')).includes('fixture-pass-key'))
 assert.equal(JSON.parse(await readFile(path.join(dir,'providers.json'),'utf8')).providers.length,0)
 console.log(JSON.stringify({status:'passed',evidence:'fixture',dir,checks:['five Cline Free accounts preserved','legacy key migrated with stable id and selection','separate Auth groups','browser reconnect deduplicates key subscription','three provider quota windows','direct plan inference','sealed credentials']}))
} finally {await app.close()}
