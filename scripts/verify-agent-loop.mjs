// Exercises the real Electron IPC -> runtime -> agent -> tools -> SSE transport.
// All model responses are fixtures; no provider usage or external URLs.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-loop-desktop-'))
const workspace = path.join(directory, 'workspace')
await mkdir(workspace)
await writeFile(path.join(workspace, 'same.txt'), 'unchanged')
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', models: ['fixture-loop'] } } }))
const countFile = path.join(directory, 'count.json')
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const {app}=require('electron'); const {writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(directory)});
let count=0;
global.fetch=async(input,options)=>{
  if(!String(input).endsWith('/chat/completions'))throw Error('Unexpected request '+input);
  const index=count++;writeFileSync(${JSON.stringify(countFile)},JSON.stringify(count));
  const name=index%2===0?'read_file':'list_directory';
  const args=index%2===0?{path:'same.txt'}:{path:'.'};
  const chunks=[{choices:[{index:0,delta:{content:'Checking access.',tool_calls:[{index:0,id:'call-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:5}}];
  return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
};
app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  const results = await page.evaluate(async workspace => {
    const api = window.anticode
    await api.setAutoApprove(true)
    await api.selectProvider({ provider: 'clinepass', model: 'fixture-loop' })
    await api.createSession({ sessionId: 'loop-test', mode: 'code', workspaceRoot: workspace })
    async function send(prompt, runId) {
      const done = new Promise((resolve,reject) => {
        const timer=setTimeout(()=>{off();reject(Error('Run timeout'))},15000)
        const off=api.onAgentEvent(event=>{
          if(event.sessionId!=='loop-test')return
          if(event.type==='error'||event.type==='end'){clearTimeout(timer);off();resolve(event)}
        })
      })
      await api.sendPrompt({ sessionId:'loop-test',runId,prompt,attachmentIds:[] })
      return done
    }
    const first=await send('Inspect the file once.', 'loop-first')
    const resumed=await send('lanjut', 'loop-resume')
    return {first,resumed}
  }, workspace)
  assert.match(results.first.message, /repeated tool loop/)
  assert.match(results.resumed.message, /repeated tool loop/)
  const requests = JSON.parse(await readFile(countFile, 'utf8'))
  assert.ok(requests <= 10, `Repeated loop must remain bounded, got ${requests} requests`)
  console.log(`PASS: alternating tool loop remains bounded on Continue (${requests} total requests)`)
  console.log(JSON.stringify({directory}))
} finally {await app.close()}
