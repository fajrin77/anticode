// Real Electron workflows against a local provider and disposable files/profile.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(),'anticode-workflow-fixes-'))
const profile = path.join(directory,'profile');await mkdir(profile)
const attachment = path.join(directory,'reference.txt');await writeFile(attachment,'The reference code is UX-42.')
const destination = path.join(directory,'saved.txt')
const requests=[]
const stub=createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'test-model'}]}));return}
  let raw='';for await(const part of req)raw+=part
  const body=JSON.parse(raw);requests.push(body)
  const text=JSON.stringify(body.messages.at(-1)?.content)
  res.writeHead(200,{'content-type':'text/event-stream'})
  const chunk=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`)
  chunk({content:'Workflow reply: '})
  await new Promise(r=>setTimeout(r,text.includes('slow')?3000:80))
  if(res.destroyed)return
  chunk({content:'finished'});chunk({},'stop');res.end('data: [DONE]\n\n')
})
await new Promise(r=>stub.listen(0,'127.0.0.1',r))
await writeFile(path.join(profile,'settings.json'),JSON.stringify({rotation:{entries:[{provider:'clinepass',model:'test-model'}],usage:{}}}))
const bootstrap=path.join(directory,'bootstrap.cjs')
await writeFile(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env={...process.env,CLINEPASS_API_KEY:'fixture',CLINEPASS_BASE_URL:`http://127.0.0.1:${stub.address().port}/v1`,CLINEPASS_MODEL:'test-model',ANTICODE_REMOTE_PORT:'0'};delete env.ELECTRON_RUN_AS_NODE
let app
const launch=async()=>{app=await electron.launch({args:[bootstrap],env,cwd:directory});const page=await app.firstWindow();await page.getByTitle('Settings',{exact:true}).waitFor();return page}
try {
  let page=await launch()
  await page.getByRole('button',{name:'antichat',exact:true}).click()
  const composer=()=>page.getByPlaceholder(/just vibes|what to change|Add to the task|Queue the next/)
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>{await new Promise(r=>setTimeout(r,500));return{canceled:false,filePaths:[file]}}},attachment)
  await composer().fill('dashboard draft survives settings')
  await page.getByTitle('Attach files',{exact:true}).click()
  await page.getByText(/Preparing attachments/).waitFor()
  await composer().press('Enter')
  assert.equal(requests.length,0)
  await page.getByText('reference.txt',{exact:true}).waitFor()
  await page.getByTitle('Settings',{exact:true}).click()
  await page.getByTitle('Settings',{exact:true}).click()
  assert.equal(await composer().inputValue(),'dashboard draft survives settings')
  assert.equal(await page.getByText('reference.txt',{exact:true}).count(),1)
  await page.getByTitle('Remove',{exact:true}).click()
  console.log('PASS: dashboard blocks early send and retains draft/files when opening Settings')
  await composer().fill('slow task')
  await composer().press('Enter')
  await page.getByRole('button',{name:'Pause',exact:true}).waitFor()
  await composer().fill('keep this next instruction')
  assert.equal(await page.getByRole('button',{name:'Pause',exact:true}).count(),1)
  await page.getByRole('button',{name:'Pause',exact:true}).click()
  await page.getByRole('button',{name:/Revert/}).waitFor()
  assert.equal(await composer().inputValue(),'keep this next instruction')
  assert.equal(requests.length,1,'pause must not send the draft')
  console.log('PASS: pause remains available while typing and preserves draft')
  await composer().fill('')
  await page.getByRole('button',{name:'Continue',exact:true}).click()
  await page.getByText(/Workflow reply:.*finished/).waitFor()
  await page.getByRole('button',{name:'Send',exact:true}).waitFor()

  // Delay the native picker deterministically; do not alter preparation or send IPC.
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>{await new Promise(r=>setTimeout(r,600));return{canceled:false,filePaths:[file]}}},attachment)
  await composer().fill('read the reference')
  const before=requests.length
  await page.getByTitle('Attach files',{exact:true}).click()
  await page.getByText(/Preparing attachments/).waitFor()
  await composer().press('Enter')
  assert.equal(requests.length,before)
  await page.getByText('reference.txt',{exact:true}).waitFor()
  await page.getByText(/Preparing attachments/).waitFor({state:'hidden'})
  await composer().press('Enter')
  await page.getByRole('button',{name:'Pause',exact:true}).waitFor({state:'hidden'})
  await page.waitForFunction(()=>!Object.keys(window.__store.getState().activeRuns).length)
  assert.match(JSON.stringify(requests.at(-1)),/UX-42/)
  console.log('PASS: Enter cannot outrun attachment preparation; the final request contains the file')

  // A mixed browser-style drop must preserve successes and display failures.
  await page.locator('[data-drop-zone]').evaluate(el=>{
    const data=new DataTransfer()
    data.items.add(new File(['valid text'],'good.txt',{type:'text/plain'}))
    const bad = new File(['unreadable'],'bad.txt')
    Object.defineProperty(bad, 'arrayBuffer', { value: async () => { throw new Error('bad.txt: read failed') } })
    data.items.add(bad)
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}))
  })
  await page.getByText('good.txt',{exact:true}).waitFor()
  await page.getByText('Dismiss attachment errors',{exact:true}).waitFor()
  await composer().fill('do not omit failures silently')
  assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true)
  await page.getByText('Dismiss attachment errors',{exact:true}).click()
  const draft=await page.evaluate(()=>{const s=window.__store.getState();return{id:s.activeSessionId,files:s.drafts[s.activeSessionId].attachments}})
  assert.equal(draft.files.length,1)
  assert.ok(draft.files[0].path.startsWith(path.join(profile,'draft-attachments')))
  console.log('PASS: mixed drop keeps valid file, surfaces failure, and stores pasted bytes durably')

  // A full process restart must re-register IDs and retain draft text/files.
  await app.close();page=await launch()
  await page.getByText('good.txt',{exact:true}).waitFor()
  await page.getByText(/Preparing attachments/).waitFor({state:'hidden'})
  assert.equal(await composer().inputValue(),'do not omit failures silently')
  const restored=await page.evaluate(()=>{const s=window.__store.getState();return s.drafts[s.activeSessionId].attachments[0]})
  assert.notEqual(restored.id,draft.files[0].id)
  await composer().press('Enter')
  await page.waitForFunction(()=>!Object.keys(window.__store.getState().activeRuns).length)
  assert.match(JSON.stringify(requests.at(-1)),/valid text/)
  console.log('PASS: restart restores draft attachment with a usable new ID')

  // Missing references after restart must remain visible and block accidental sends.
  await page.evaluate(async(file)=>{const files=await window.anticode.addAttachments([file]);const s=window.__store.getState();s.updateDraft(s.activeSessionId,{text:'missing attachment check',attachments:files})},attachment)
  await app.close();await unlink(attachment);page=await launch()
  await page.getByText('Dismiss attachment errors',{exact:true}).waitFor()
  assert.equal(await composer().inputValue(),'missing attachment check')
  assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true)
  await page.getByText('Dismiss attachment errors',{exact:true}).click()
  console.log('PASS: missing files after restart remain actionable; text survives')

  // Long conversations must retain a reading position across tab switches.
  await page.evaluate(()=>{const s=window.__store.getState();s.addMessage({id:crypto.randomUUID(),role:'assistant',pending:false,parts:[{kind:'text',text:'Reading position paragraph.\n\n'.repeat(80)}]})})
  const firstTitle=await page.locator('[data-session-tabs] > div').first().locator('button').first().getAttribute('title')
  const scroller=()=>page.locator('[data-transcript]').locator('..')
  await scroller().evaluate(el=>{el.scrollTop=250;el.dispatchEvent(new Event('scroll',{bubbles:true}))})
  await page.getByRole('button',{name:'New tab',exact:true}).click()
  await page.getByTitle(firstTitle,{exact:true}).click()
  assert.ok(Math.abs(await scroller().evaluate(el=>el.scrollTop)-250)<2)
  console.log('PASS: returning to a long chat restores the reading position')

  // Real save IPC and copy, with a delayed native dialog to expose double clicks.
  await app.evaluate(({dialog},file)=>{globalThis.saveDialogs=0;dialog.showSaveDialog=async()=>{globalThis.saveDialogs++;await new Promise(r=>setTimeout(r,500));return{canceled:false,filePath:file}}},destination)
  const result=await page.evaluate(async()=>{
    const s=window.__store.getState(),id=s.activeSessionId
    const results=await Promise.all([window.anticode.saveArtifact(id,'good.txt'),window.anticode.saveArtifact(id,'good.txt')])
    return results
  })
  assert.deepEqual(result,[destination,destination])
  assert.equal(await app.evaluate(()=>globalThis.saveDialogs),1)
  assert.equal(await readFile(destination,'utf8'),'valid text')
  console.log('PASS: concurrent downloads share one save dialog and produce intact bytes')
  await page.evaluate(()=>{const s=window.__store.getState();s.addMessage({id:crypto.randomUUID(),role:'assistant',pending:false,parts:[
    {kind:'tool',toolUseId:crypto.randomUUID(),name:'share_file',status:'ok',input:{path:'good.txt'},output:'Shared good.txt'}
  ]})})
  await page.getByRole('button',{name:'Download',exact:true}).click()
  const saving=page.getByRole('button',{name:'Saving…',exact:true})
  await saving.waitFor()
  assert.equal(await saving.isDisabled(),true)
  await page.getByText(`Saved to ${destination}`,{exact:true}).waitFor()
  assert.equal(await app.evaluate(()=>globalThis.saveDialogs),2)
  console.log('PASS: artifact UI displays Saving, disables repeat clicks and reports destination')


  await page.getByTitle('Settings',{exact:true}).click()
  await page.getByText('Tools and computer use',{exact:true}).waitFor()
  const info=await page.evaluate(()=>window.anticode.getAppInfo())
  assert.equal(typeof info.screenRecording,'string')
  assert.equal(info.version,JSON.parse(await readFile(path.resolve('package.json'),'utf8')).version)
  assert.equal(await page.getByText('Skip medium-risk approvals; high-risk actions still ask in Auto',{exact:true}).count(),1)
  await page.getByText('Refresh permissions',{exact:true}).click()
  await page.screenshot({path:path.join(directory,'capabilities.png')})
  console.log('PASS: settings explains real tool capabilities and reports OS permission status')
  console.log(JSON.stringify({directory,requests:requests.length}))
} finally {if(app)await app.close().catch(()=>{});await new Promise(r=>stub.close(r))}
