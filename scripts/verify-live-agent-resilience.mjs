// Explicit live subscription test, using the real profile without copying/rotating OAuth in a second store.
// All coding and deliberate stream disruption stay inside this test's temporary workspace/session.
import {_electron as electron} from 'playwright'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {tmpdir} from 'node:os'
import path from 'node:path'
const execute=promisify(execFile)
if(!process.argv.includes('--live'))throw Error('Pass --live to spend a small amount of the connected subscription quota.')
const directory=await mkdtemp(path.join(tmpdir(),'anticode-live-agent-resilience-'))
const binary=path.resolve('release/mac-arm64/anticode.app/Contents/MacOS/anticode')
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const app=await electron.launch({executablePath:binary,env})
const results=[];let original
try{
 const page=await app.firstWindow();original=await page.evaluate(()=>window.anticode.getStatus())
 const providers=await page.evaluate(()=>window.anticode.listProviders())
 const choices=[['claude','claude-sonnet-5-5'],['clinepass','cline-pass/muse-spark-1.3-contributor'],['codex','gpt-6.1-sol'],['claude','claude-opus-5-5']]
 for(const [index,[kind,model]] of choices.entries()){
  const provider=providers.find(p=>p.authKind===kind&&p.composerVisible&&p.credentialAvailable&&p.models?.includes(model))
  if(!provider){results.push({model,ok:false,reason:'No enabled account advertises this exact model'});continue}
  const root=path.join(directory,'case-'+index);await mkdir(root)
  await writeFile(path.join(root,'normalize.mjs'),"export function normalizeSku(value){return String(value).toLowerCase()}\nexport function parseQuantity(value){return Number(value)||1}\n")
  await writeFile(path.join(root,'import.mjs'),"import {normalizeSku,parseQuantity} from './normalize.mjs'\nexport function mergeRows(rows){return rows.filter(r=>r.quantity).map(r=>({sku:normalizeSku(r.sku),quantity:parseQuantity(r.quantity)}))}\n")
  const tests=`import {test} from 'node:test';import assert from 'node:assert/strict';import {normalizeSku,parseQuantity} from './normalize.mjs';import {mergeRows} from './import.mjs';
 test('SKU normalization',()=>assert.equal(normalizeSku('  ａｂ  cd  '),'AB-CD'));
 test('reject invalid SKU',()=>{for(const x of ['',null,3])assert.throws(()=>normalizeSku(x))});
 test('zero quantity survives',()=>assert.equal(parseQuantity(' 0 '),0));
 test('integer parsing',()=>assert.equal(parseQuantity('12'),12));
 test('reject invalid quantities',()=>{for(const x of ['',-1,1.5,NaN,Infinity,'2x',null])assert.throws(()=>parseQuantity(x))});
 test('merge duplicates last row wins',()=>assert.deepEqual(mergeRows([{sku:'a',quantity:1},{sku:'B',quantity:2},{sku:'Ａ',quantity:0}]),[{sku:'A',quantity:0},{sku:'B',quantity:2}]));
 test('inputs remain unchanged',()=>{const rows=[{sku:' a ',quantity:'2'}];const old=structuredClone(rows);mergeRows(rows);assert.deepEqual(rows,old)});
 test('idempotent normalization',()=>{const x=mergeRows([{sku:' a ',quantity:'0'}]);assert.deepEqual(mergeRows(x),x)});
 test('empty input',()=>assert.deepEqual(mergeRows([]),[]));`
  await writeFile(path.join(root,'acceptance.test.mjs'),tests)
  await writeFile(path.join(root,'fixtures.json'),JSON.stringify([{sku:' a ',quantity:'0'},{sku:'B',quantity:2},{sku:'Ａ',quantity:3}]))
  if(kind==='clinepass')await app.evaluate(()=>{
   globalThis.resilienceOriginalFetch=globalThis.fetch;globalThis.resilienceDropped=false
   globalThis.fetch=async(...args)=>{
    const response=await globalThis.resilienceOriginalFetch(...args)
    if(globalThis.resilienceDropped||!String(args[0]).endsWith('/chat/completions')||!response.ok||!response.body)return response
    globalThis.resilienceDropped=true
    const reader=response.body.getReader();let sent=false
    const body=new ReadableStream({async pull(controller){if(sent){await reader.cancel();controller.error(new Error('fetch failed'));return}const part=await reader.read();if(part.done){controller.close();return}sent=true;controller.enqueue(part.value)},cancel(){return reader.cancel()}})
    return new Response(body,{status:response.status,headers:response.headers})
   }
  })
  console.log(JSON.stringify({phase:'start',model,workspace:root}))
  const started=Date.now(),sessionId='resilience-live-'+Date.now()+'-'+index
  let outcome
  try{
   outcome=await page.evaluate(async({root,sessionId,provider,model,index})=>{
    const api=window.anticode;await api.setAutoApprove(true);await api.setFollowUpMode('steer')
    await api.createSession({sessionId,mode:'code',workspaceRoot:root});await api.selectProvider({provider,model},sessionId)
    let tools=0,notices=0,steered=false,steerPromise=null
    const done=new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>{off();api.pauseSession(sessionId);reject(Error('Live task exceeded ten minutes'))},600000)
     const off=api.onAgentEvent(e=>{
      if(e.sessionId!==sessionId)return
      if(e.type==='tool_end'){
       tools++
       if(tools===2&&!steered){steered=true;steerPromise=api.sendPrompt({sessionId,runId:'steer-'+index,prompt:'Additional requirement while you work: after all acceptance tests pass, use mergeRows on fixtures.json and write report.json with {"count":2,"validated":true}. Keep completing the original task in this same run. Do not edit acceptance.test.mjs.',attachmentIds:[]})}
      }
      if(e.type==='notice')notices++
      if(e.type==='error'){clearTimeout(timer);off();resolve({ok:false,tools,notices,steered,error:e.message})}
      if(e.type==='end'){clearTimeout(timer);off();resolve({ok:e.reason==='complete',tools,notices,steered,reason:e.reason})}
     })
    })
    try{await api.sendPrompt({sessionId,runId:'live-'+index,prompt:'Fix normalize.mjs and import.mjs to satisfy every test in acceptance.test.mjs. SKU must be a nonempty string, NFKC normalized, trimmed, uppercase, with each whitespace run replaced by a hyphen. Quantities must be nonnegative integers provided as numbers or nonempty numeric strings; reject invalid values. mergeRows keeps first SKU order and the last quantity, preserves zero, and never mutates the input. Use tools to inspect, implement, run node --test acceptance.test.mjs, fix any failures, verify the result and finish. Do not modify tests. Keep a checklist until the complete task is done.',attachmentIds:[]})}catch(e){return {ok:false,error:e.message,tools,notices,steered}}
    const result=await done;if(steerPromise)await steerPromise;return result
   },{root,sessionId,provider:provider.id,model,index})
   let passed=false,report=false,testUnchanged=false
   try{await execute(process.execPath,['--test','acceptance.test.mjs'],{cwd:root});passed=true}catch{}
   try{const r=JSON.parse(await readFile(path.join(root,'report.json'),'utf8'));report=r.count===2&&r.validated===true}catch{}
   testUnchanged=(await readFile(path.join(root,'acceptance.test.mjs'),'utf8'))===tests
   const dropped=kind==='clinepass'?await app.evaluate(()=>globalThis.resilienceDropped):false
   results.push({model,...outcome,error:outcome.error?.replace(/(?:sk-|sbp_)[\w-]+/g,'[redacted]').slice(0,450),passed,report,testUnchanged,dropped,elapsedSeconds:Math.round((Date.now()-started)/1000)})
  }catch(error){results.push({model,ok:false,error:error.message.slice(0,350)})}
  finally{
   if(kind==='clinepass')await app.evaluate(()=>{if(globalThis.resilienceOriginalFetch)globalThis.fetch=globalThis.resilienceOriginalFetch})
   await page.evaluate(id=>window.anticode.closeSession(id),sessionId).catch(()=>{})
  }
  console.log(JSON.stringify(results.at(-1)))
 }
 await writeFile(path.join(directory,'results.json'),JSON.stringify(results,null,2))
 console.log(JSON.stringify({directory,results}))
}finally{
 if(original){const page=await app.firstWindow();await page.evaluate(async s=>{const api=window.anticode;await api.setAutoApprove(s.autoApprove);await api.setFollowUpMode(s.followUpMode);await api.selectProvider({provider:s.defaultProvider,model:s.defaultModel})},original).catch(()=>{})}
 await app.close()
}
