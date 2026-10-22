// Production Electron/IPC/provider/agent loop. Vendor traffic is a controlled fixture.
import {_electron as electron} from 'playwright'
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import sharp from 'sharp'
const dir=await mkdtemp(path.join(tmpdir(),'anticode-run-resilience-')),workspace=path.join(dir,'workspace')
await mkdir(workspace)
for(let i=0;i<40;i++)await writeFile(path.join(workspace,`fact-${i}.txt`),`CRITICAL_FACT_${i}\n`+'evidence '.repeat(250))
await writeFile(path.join(workspace,'common.txt'),'unchanged common fact')
await writeFile(path.join(dir,'providers.json'),JSON.stringify({providers:[],builtin:{clinepass:{removed:true}}}))
await writeFile(path.join(dir,'settings.json'),JSON.stringify({remote:{enabled:false},updates:{autoCheck:false}}))
const bootstrap=path.join(dir,'bootstrap.cjs')
await writeFile(bootstrap,`
const {app}=require('electron'),fs=require('node:fs');app.setPath('userData',${JSON.stringify(dir)});
let step=0,disconnected=false,retained=false,recoveries=0;
const resultFile=${JSON.stringify(path.join(dir,'fixture-results.json'))};
function response(content,calls){return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{...(content?{content}:{}),...(calls?{tool_calls:calls}: {})},finish_reason:calls?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:8}})+'\\n\\ndata: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}})}
function tool(name,args,id){return {index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}}
global.fetch=async(input,options={})=>{
 const url=String(input);if(url.endsWith('/models'))return Response.json({data:[{id:'fixture-recovery'}]});
 if(!url.endsWith('/chat/completions'))throw Error('Unexpected fixture URL');
 const request=JSON.parse(options.body),messages=request.messages;
 if(step===10)retained=messages.some(m=>m.role==='tool'&&String(m.content).includes('CRITICAL_FACT_0'));
 if(step===8&&!disconnected){disconnected=true;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{index:0,delta:{content:'Partial progress before a network drop.'}}]})+'\\n\\n'));setTimeout(()=>controller.error(new Error('fetch failed')),30)}}),{headers:{'content-type':'text/event-stream'}})}
 if(step<40){const i=step++;return response('Reading the next fact.',[
  {...tool('read_file',{path:'common.txt'},'common-'+i),index:0},
  {...tool('read_file',{path:'fact-'+i+'.txt'},'fact-'+i),index:1}
 ])}
 const last=JSON.stringify(messages.at(-1)?.content??'');
 if(step===40&&!last.includes('Repeated checks'))return response('Checking the common fact again.',[tool('read_file',{path:'common.txt'},'stalled-'+Date.now())]);
 if(step===40){step++;recoveries++;return response('Using existing evidence to finish.',[tool('run_command',{command:"node -e \\"require('fs').writeFileSync('result.txt','VERIFIED')\\""},'write-result')])}
 if(step===41){step++;return response('',[tool('read_file',{path:'result.txt'},'verify-result')])}
 fs.writeFileSync(resultFile,JSON.stringify({step,disconnected,retained,recoveries}));return response('VERIFIED');
};
app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
let app=await electron.launch({args:[bootstrap],env})
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'antichat',exact:true}).click()
 const png=(await sharp({create:{width:20,height:20,channels:4,background:'#44bbcc'}}).png().toBuffer()).toString('base64')
 const [oldA,oldB]=await Promise.all([page.evaluate(()=>window.anticode.addAttachmentData('old-a.txt',btoa('a'))),page.evaluate(()=>window.anticode.addAttachmentData('old-b.txt',btoa('b')))])
 const only=await page.evaluate(file=>window.anticode.addAttachments([file]),path.join(workspace,'common.txt'))
 assert.equal(only.length,1)
 async function paste(){await page.locator('textarea').evaluate((el,png)=>{const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'single.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))},png);await page.getByTitle('Remove',{exact:true}).first().waitFor();await page.waitForFunction(()=>!document.body.innerText.includes('Preparing attachments'))}
 await paste();assert.equal(await page.getByTitle('Remove',{exact:true}).count(),1)
 await paste();assert.equal(await page.getByTitle('Remove',{exact:true}).count(),1)
 const result=await page.evaluate(async workspace=>{
  const api=window.anticode;const rows=await api.addProvider({label:'Recovery fixture',kind:'openai',apiKey:'fixture-key',baseURL:'https://fixture.invalid/v1',models:['fixture-recovery']});
  const provider=rows.find(p=>p.label==='Recovery fixture');await api.setProviderVisibility(provider.id,true);await api.setAutoApprove(true)
  const sessionId='long-recovery';await api.createSession({sessionId,mode:'code',workspaceRoot:workspace});await api.selectProvider({provider:provider.id,model:'fixture-recovery'},sessionId)
  const done=new Promise((resolve,reject)=>{let tools=0,notices=[];const timer=setTimeout(()=>{off();reject(Error('Long-run fixture timeout'))},90000);const off=api.onAgentEvent(e=>{if(e.sessionId!==sessionId)return;if(e.type==='tool_end')tools++;if(e.type==='notice')notices.push(e.text);if(e.type==='error'){clearTimeout(timer);off();reject(Error(e.message))}if(e.type==='end'){clearTimeout(timer);off();resolve({tools,notices,reason:e.reason})}})})
  await api.sendPrompt({sessionId,runId:'long-recovery',prompt:'Read the facts, use the evidence to create result.txt, verify it, and finish.',attachmentIds:[]});return done
 },workspace)
 assert.equal(await page.getByTitle('Remove',{exact:true}).count(),1);assert.equal(result.reason,'complete');assert.ok(result.tools>=82);assert.equal(await readFile(path.join(workspace,'result.txt'),'utf8'),'VERIFIED')
 const recorded=JSON.parse(await readFile(path.join(dir,'fixture-results.json'),'utf8'));assert.equal(recorded.retained,true);assert.equal(recorded.disconnected,true);assert.equal(recorded.recoveries,1)
 await page.evaluate(()=>{
  const name=Object.keys(localStorage).find(key=>{try{return JSON.parse(localStorage.getItem(key)).state?.drafts?.__dashboard__?.attachments?.length}catch{return false}})
  if(!name)throw Error('Missing persisted dashboard photo')
  const data=JSON.parse(localStorage.getItem(name)),photo=data.state.drafts.__dashboard__.attachments[0]
  delete photo.contentHash
  data.state.drafts.__dashboard__.attachments=[0,1,2].map(i=>({...photo,id:'legacy-photo-'+i}))
  localStorage.setItem(name,JSON.stringify(data))
 })
 await app.close();app=await electron.launch({args:[bootstrap],env})
 const restored=await app.firstWindow();await restored.getByRole('button',{name:'antichat',exact:true}).click()
 await restored.getByTitle('Remove',{exact:true}).first().waitFor()
 await restored.waitForFunction(()=>!document.body.innerText.includes('Preparing attachments'))
 assert.equal(await restored.getByTitle('Remove',{exact:true}).count(),1)
 console.log(JSON.stringify({status:'passed',evidence:'fixture',dir,tools:result.tools,...recorded,checks:['one photo stays one attachment, including legacy duplicates after restart','new file does not return old staged files','40 rounds retain original evidence','common reads alongside new facts are not stopped','partial stream resumes automatically','stalled checking recovers to write and verification']}))
}finally{await app.close()}
