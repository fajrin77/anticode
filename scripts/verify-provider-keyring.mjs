// Actual UI/IPC/storage/provider integration, using an isolated profile and fixture keys only.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp('/tmp/anticode-keyring-')
await writeFile(path.join(directory,'providers.json'),JSON.stringify({providers:[],builtin:{clinepass:{removed:true}}}))
const bootstrap=path.join(directory,'bootstrap.cjs')
await writeFile(bootstrap,`
const {app}=require('electron');
const {writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(directory)});
const calls=[];
global.fetch=async (input,options={})=>{
 const url=String(input);
 if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'fixture-model'}]}));
 if(url.endsWith('/chat/completions')){
  calls.push(new Headers(options.headers).get('authorization'));
  writeFileSync(${JSON.stringify(path.join(directory,'calls.json'))},JSON.stringify(calls));
  return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
 }
 throw Error('Unexpected fixture network URL: '+url);
};
app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env={...process.env,ANTICODE_REMOTE_PORT:'0'}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const launch=()=>electron.launch({args:[bootstrap],env,cwd:directory})
let app=await launch()
try {
 const page=await app.firstWindow()
 const id=await page.evaluate(async()=>{
  const providers=await window.anticode.addProvider({kind:'openai',label:'One gateway',baseURL:'https://fixture.invalid/v1',apiKey:'fixture-first-key',models:['fixture-model']})
  const id=providers.find(p=>p.label==='One gateway').id
  await window.anticode.setRotation([{provider:id,model:'fixture-model'}])
  await window.anticode.selectProvider({provider:id,model:'fixture-model'})
  return id
 })
 await page.getByTitle('Settings',{exact:true}).click()
 await page.getByRole('button',{name:'Providers',exact:true}).click()
 await page.getByTitle('Edit One gateway',{exact:true}).click()
 await page.getByLabel('Add API keys',{exact:true}).fill('fixture-second-key\nfixture-first-key')
 await page.getByRole('button',{name:'Save',exact:true}).click()
 await page.getByText(/2 keys saved/).waitFor()
 await page.getByRole('switch',{name:'Show One gateway in composer',exact:true}).click()
 await page.screenshot({path:path.join(directory,'provider-two-keys.png')})
 await page.getByRole('button',{name:/Back/}).click()
 await page.getByRole('button',{name:'antichat',exact:true}).click()
 await page.getByRole('button',{name:'fixture-model',exact:true}).click()
 assert.equal(await page.locator('[data-picker-model="fixture-model"]').count(),1)
 await page.keyboard.press('Escape')
 await page.evaluate(async(id)=>{
  const api=window.anticode
  await api.createSession({sessionId:'key-sharing',mode:'chat',workspaceRoot:null})
  await api.selectProvider({provider:id,model:'fixture-model'},'key-sharing')
  for(let i=0;i<4;i++){
   const done=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(Error('Key pool timeout'))},15000)
    const off=api.onAgentEvent(event=>{
     if(event.sessionId!=='key-sharing')return
     if(event.type==='error'){clearTimeout(timer);off();reject(Error(event.message))}
     if(event.type==='end'){clearTimeout(timer);off();resolve(event)}
    })
   })
   await api.sendPrompt({sessionId:'key-sharing',runId:'key-pool-'+i,prompt:'Reply OK only.',attachmentIds:[]})
   await done
  }
 },id)
 assert.deepEqual(JSON.parse(await readFile(path.join(directory,'calls.json'),'utf8')),['Bearer fixture-first-key','Bearer fixture-second-key','Bearer fixture-first-key','Bearer fixture-second-key'])
 const stored=await readFile(path.join(directory,'providers.json'),'utf8')
 assert.ok(!stored.includes('fixture-first-key')&&!stored.includes('fixture-second-key'))
 await app.close()
 app=await launch()
 const restarted=await app.firstWindow()
 const providers=await restarted.evaluate(()=>window.anticode.listProviders())
 assert.equal(providers.length,1)
 assert.equal(providers[0].keyCount,2)
 assert.equal(providers[0].composerVisible,true)
 assert.equal(providers[0].credentialAvailable,true)
 console.log('PASS: add second API key in UI, one provider/model in composer, four requests split across two keys, encrypted storage and restart persistence')
 console.log(JSON.stringify({directory}))
}finally{await app.close()}
