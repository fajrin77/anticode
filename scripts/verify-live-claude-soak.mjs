// Real Claude inference and host tool execution. Only the verification endpoint is fault-injected after its cache expires.
import {_electron as electron} from 'playwright'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
if(!process.argv.includes('--live'))throw Error('Pass --live to run the six-minute live subscription soak.')
const directory=await mkdtemp(path.join(tmpdir(),'anticode-claude-live-soak-'))
await writeFile(path.join(directory,'soak.mjs'),`import fs from 'node:fs';const started=Date.now();for(let i=0;i<31;i++){await new Promise(r=>setTimeout(r,10000));console.log('build step '+(i+1)+'/31')}fs.writeFileSync('output.json',JSON.stringify({value:31,elapsedMs:Date.now()-started}));console.log('BUILD_COMPLETE');`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const app=await electron.launch({executablePath:path.resolve('release/mac-arm64/anticode.app/Contents/MacOS/anticode'),env})
const sessionId='claude-soak-'+Date.now();let original
try{
 const page=await app.firstWindow();original=await page.evaluate(()=>window.anticode.getStatus())
 const provider=await page.evaluate(async()=> (await window.anticode.listProviders()).find(p=>p.authKind==='claude'&&p.composerVisible&&p.credentialAvailable&&p.models?.includes('claude-sonnet-5-5')))
 if(!provider)throw Error('No enabled Claude Sonnet account')
 await app.evaluate(()=>{
  globalThis.soakStarted=Date.now();globalThis.soakMetadataRefusals=0;globalThis.soakOriginalFetch=globalThis.fetch
  globalThis.fetch=async(...args)=>{
   if(String(args[0]).includes('api.anthropic.com/api/oauth/')&&Date.now()-globalThis.soakStarted>=300000){globalThis.soakMetadataRefusals++;return new Response('{}',{status:429,headers:{'retry-after':'120'}})}
   return globalThis.soakOriginalFetch(...args)
  }
 })
 console.log(JSON.stringify({phase:'started',directory,model:'claude-sonnet-5-5',minimumDurationSeconds:310}))
 const result=await page.evaluate(async({directory,sessionId,provider})=>{
  const api=window.anticode;await api.setAutoApprove(true);await api.setFollowUpMode('steer');await api.createSession({sessionId,mode:'code',workspaceRoot:directory});await api.selectProvider({provider,model:'claude-sonnet-5-5'},sessionId)
  let tools=0,notices=0,progress=0,followUp=false,steerPromise=null
  const done=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{off();api.pauseSession(sessionId);reject(Error('Soak exceeded nine minutes'))},540000)
   const off=api.onAgentEvent(e=>{
    if(e.sessionId!==sessionId)return
    if(e.type==='tool_progress')progress++
    if(e.type==='tool_start'&&!followUp){followUp=true;steerPromise=api.sendPrompt({sessionId,runId:'soak-steer',prompt:'After the long command completes and output.json is verified, also write followup.txt containing STEERING_PRESERVED. Keep the original task and wait for the command normally.',attachmentIds:[]})}
    if(e.type==='tool_end')tools++
    if(e.type==='notice')notices++
    if(e.type==='error'){clearTimeout(timer);off();resolve({ok:false,error:e.message,tools,notices,progress,followUp})}
    if(e.type==='end'){clearTimeout(timer);off();resolve({ok:e.reason==='complete',tools,notices,progress,followUp})}
   })
  })
  await api.sendPrompt({sessionId,runId:'live-soak',prompt:'Run this long build using run_command with command "node soak.mjs" and timeout_ms 400000. Let it run normally in the foreground; do not edit soak.mjs, background it, shorten it, or replace it. After it finishes, read output.json, independently verify value===31 and elapsedMs>=310000 using a command, write verified.json with {"verified":true}, then finish. Preserve any instruction arriving during the build. This deliberately tests a real long host tool and subsequent model request.',attachmentIds:[]})
  const result=await done;if(steerPromise)await steerPromise;return result
 },{directory,sessionId,provider:provider.id})
 const refused=await app.evaluate(()=>globalThis.soakMetadataRefusals)
 const output=JSON.parse(await readFile(path.join(directory,'output.json'),'utf8').catch(()=>'{"elapsedMs":0}'))
 const verified=JSON.parse(await readFile(path.join(directory,'verified.json'),'utf8').catch(()=>'{"verified":false}'))
 const followup=(await readFile(path.join(directory,'followup.txt'),'utf8').catch(()=>'')).trim()==='STEERING_PRESERVED'
 const evidence={evidence:'live-inference-plus-verification-fault',...result,directory,elapsedMs:output.elapsedMs,metadata429s:refused,verified:verified.verified===true,followupPreserved:followup}
 await writeFile(path.join(directory,'results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence))
}finally{
 await app.evaluate(()=>{if(globalThis.soakOriginalFetch)globalThis.fetch=globalThis.soakOriginalFetch}).catch(()=>{})
 const page=await app.firstWindow();await page.evaluate(id=>window.anticode.closeSession(id),sessionId).catch(()=>{})
 if(original)await page.evaluate(async s=>{const api=window.anticode;await api.setAutoApprove(s.autoApprove);await api.setFollowUpMode(s.followUpMode);await api.selectProvider({provider:s.defaultProvider,model:s.defaultModel})},original).catch(()=>{})
 await app.close()
}
