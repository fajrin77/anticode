// Run after npm run build. Uses a temporary profile, fixture workspace and local
// OpenAI-compatible stub; never reads account credentials or calls paid APIs.
import { _electron as electron, chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-verification-'))
const profile = path.join(directory, 'profile')
const { mkdir } = await import('node:fs/promises')
await mkdir(profile)
const workspace = path.join(directory, 'workspace'); await mkdir(workspace)
await writeFile(path.join(workspace, 'hello.txt'), 'original')
await writeFile(path.join(workspace, '<b>literal.txt'), 'literal filename')
let calls = 0
const stub = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:'test-model'},{id:'test-model-2'}]})); return }
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw); calls++
  const prompt = body.messages.filter(m=>m.role==='user').at(-1)?.content
  const text = typeof prompt === 'string' ? prompt : prompt?.filter(p=>p.type==='text').map(p=>p.text).join(' ') ?? ''
  if (text.includes('provider-error')) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'Fixture provider rejected the request'}})); return }
  res.writeHead(200, {'content-type':'text/event-stream'})
  const chunk = (delta, finish_reason=null) => res.write(`data: ${JSON.stringify({id:'test',choices:[{index:0,delta,finish_reason}]})}\n\n`)
  if (text.includes('write-fixture') && !body.messages.some(m=>m.role==='tool')) {
    chunk({tool_calls:[{index:0,id:'write-test',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'hello.txt',content:'written by approved tool'})}}]})
    chunk({}, 'tool_calls')
  } else {
    chunk({content:'Fixture reply: '})
    await new Promise(r=>setTimeout(r,text.includes('slow') ? 2000 : 100))
    if (res.destroyed) return
    chunk({content:text.slice(0,80) || 'done'})
    chunk({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(r=>stub.listen(0,'127.0.0.1',r))
const stubPort = stub.address().port
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = {...process.env, CLINEPASS_API_KEY:'fixture-key', CLINEPASS_BASE_URL:`http://127.0.0.1:${stubPort}/v1`, CLINEPASS_MODEL:'test-model', ANTICODE_REMOTE_PORT:'18680'}
delete env.ELECTRON_RUN_AS_NODE
let app = await electron.launch({args:[bootstrap], env, cwd: directory})
app.process().stderr.on('data', data => { if (/Error|Unhandled/i.test(String(data))) console.error('MAIN:',String(data)) });
let window = await app.firstWindow(); const errors=[]
window.on('pageerror',error=>errors.push(error.message))
const log = (text) => console.log('PASS:',text)
try {
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.getByPlaceholder(/Ask anything|Describe the task/).fill('desktop-first')
  await window.getByPlaceholder(/Ask anything|Describe the task/).press('Enter')
  await window.getByText('Fixture reply: desktop-first',{exact:true}).waitFor()
  log('desktop chat streams and completes')
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.getByPlaceholder(/Ask anything|Describe the task/).fill('slow second')
  await window.getByPlaceholder(/Ask anything|Describe the task/).press('Enter')
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.getByPlaceholder(/Ask anything|Describe the task/).fill('third parallel')
  await window.getByPlaceholder(/Ask anything|Describe the task/).press('Enter')
  await window.getByText('Fixture reply: third parallel',{exact:true}).waitFor()
  await window.getByRole('button',{name:'slow second',exact:true}).click()
  await window.getByText('Fixture reply: slow second',{exact:true}).waitFor()
  assert.equal(await window.getByText('working',{exact:true}).count(),0)
  log('two desktop sessions finish independently')
  await window.getByPlaceholder('Ask anything…').fill('slow cancel')
  await window.getByPlaceholder('Ask anything…').press('Enter')
  await window.getByRole('button',{name:'Pause',exact:true}).click()
  await window.getByRole('button',{name:'Resume',exact:true}).click()
  await window.getByText(/Fixture reply: Lanjutkan/).waitFor()
  log('pause and resume retain a usable session')
  await window.getByRole('button',{name:'Settings',exact:true}).click()
  await window.getByRole('button',{name:'Remote',exact:true}).click()
  // Setup through IPC in the isolated profile, not the user's running app.
  const remote = await window.evaluate(()=>window.anticode.setRemoteEnabled(true))
  assert.equal(remote.error,null)
  const api = async (url, body) => {
    const response=await fetch(`http://127.0.0.1:18680${url}${url.includes('?')?'&':'?'}token=${remote.token}`,body===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    const json=await response.json(); if (!response.ok) throw new Error(json.error); return json
  }
  const {sessionId}=await api('/api/session',{mode:'code',folder:workspace})
  await api('/api/prompt',{sessionId,prompt:'write-fixture'})
  await window.getByRole('button',{name:'Approve',exact:true}).waitFor()
  await window.getByRole('button',{name:'Approve',exact:true}).click()
  await new Promise(r=>setTimeout(r,500))
  assert.equal(await readFile(path.join(workspace,'hello.txt'),'utf8'),'written by approved tool')
  log('remote tool approval appears in Settings and writes the fixture file')
  const remoteRun = await api('/api/prompt', {sessionId,prompt:'slow remote lock'})
  await assert.rejects(api('/api/prompt', {sessionId,prompt:'duplicate'}), /already active/)
  await assert.rejects(window.evaluate(({sessionId}) => window.anticode.sendPrompt({sessionId,runId:crypto.randomUUID(),prompt:'duplicate desktop',attachmentIds:[]}), {sessionId}), /already active/)
  await window.evaluate((runId)=>window.anticode.cancelRun(runId),remoteRun.runId)
  for (let i=0;i<50;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  assert.equal((await api('/api/session/'+sessionId)).runId,null)
  log('desktop and phone share ownership and cancellation of the same run')
  const attached = await window.evaluate((file)=>window.anticode.addAttachments([file]),path.join(workspace,'hello.txt'))
  await window.evaluate(({sessionId,attachmentId})=>window.anticode.sendPrompt({sessionId,runId:crypto.randomUUID(),prompt:'attachment test',attachmentIds:[attachmentId]}), {sessionId,attachmentId:attached[0].id})
  for (let i=0;i<50;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  const attachmentHistory = (await api('/api/session/'+sessionId)).messages
  assert(attachmentHistory.some(m=>m.blocks.some(b=>b.type==='attachment' && b.attachment.workspacePath==='hello.txt' && b.attachment.kind==='text')))
  log('attachments resolve relative to the receiving session workspace')
  const picture = await sharp({create:{width:200,height:120,channels:3,background:'#d1fa22'}}).png().toBuffer()
  const uploaded = await api('/api/attachment',{name:'layar.png',data:picture.toString('base64')})
  assert.match(uploaded.thumbnail,/^data:image\/jpeg;base64,/)
  await api('/api/prompt',{sessionId,prompt:'lihat lampiran',attachmentIds:[uploaded.id]})
  for (let i=0;i<100;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  const uploadHistory = (await api('/api/session/'+sessionId)).messages
  assert(uploadHistory.some(m=>m.blocks.some(b=>b.type==='attachment' && b.attachment.name==='layar.png' && b.attachment.thumbnail?.startsWith('data:image/jpeg;base64,'))))
  log('a file uploaded from the phone reaches the transcript as a drawable attachment')
  await writeFile(path.join(workspace,'laporan.pdf'),'fixture pdf')
  const download = await fetch(`http://127.0.0.1:18680/api/download?sessionId=${sessionId}&path=laporan.pdf&token=${remote.token}`)
  assert.equal(download.status,200)
  assert.equal(download.headers.get('content-type'),'application/pdf')
  assert.match(download.headers.get('content-disposition'),/laporan\.pdf/)
  assert.equal(await download.text(),'fixture pdf')
  const escape = await fetch(`http://127.0.0.1:18680/api/download?sessionId=${sessionId}&path=${encodeURIComponent('../secret.txt')}&token=${remote.token}`)
  assert.equal(escape.status,400)
  log('produced files download from the phone, and only from inside the folder')

  // Closing a tab only archives the session. Work arriving from the phone has
  // to bring that tab back, or the session reads as deleted on the desktop
  // while it is plainly alive on the phone.
  await window.evaluate((id)=>window.__store.getState().closeSession(id), sessionId)
  assert.equal(await window.evaluate((id)=>window.__store.getState().sessions.find(s=>s.id===id).closed, sessionId), true)
  await api('/api/prompt',{sessionId,prompt:'from the phone'})
  for (let i=0;i<100;i++) {
    if (await window.evaluate((id)=>window.__store.getState().sessions.find(s=>s.id===id).closed===false, sessionId)) break
    await new Promise(r=>setTimeout(r,20))
  }
  assert.equal(await window.evaluate((id)=>window.__store.getState().sessions.find(s=>s.id===id).closed, sessionId), false)
  // Coming back must not yank the user out of whatever tab they are in.
  assert.notEqual(await window.evaluate(()=>window.__store.getState().activeSessionId), sessionId)
  for (let i=0;i<200;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  log('a phone prompt brings an archived desktop tab back, without stealing focus')

  // The same disagreement in the other direction: a session deleted on the
  // desktop must stop looking alive to a phone sitting inside it.
  const doomed = (await api('/api/session',{mode:'chat'})).sessionId
  assert.equal((await api('/api/approvals?sessionId='+doomed)).exists, true)
  await window.evaluate((id)=>window.anticode.closeSession(id), doomed)
  assert.equal((await api('/api/approvals?sessionId='+doomed)).exists, false)
  log('a session deleted on the desktop stops reporting itself to the phone')

  // What a run cost is recorded in the main process, so the desktop and the
  // phone close a run with the same line — and so a reload keeps it.
  const summarised = await api('/api/session/'+sessionId)
  assert(Array.isArray(summarised.summaries) && summarised.summaries.length > 0)
  const last = summarised.summaries.at(-1)
  assert.equal(typeof last.model, 'string')
  assert(last.durationMs >= 0)
  assert(last.inputTokens + last.outputTokens > 0)
  const turns = summarised.messages.filter(m=>m.role==='assistant').length
  assert(summarised.summaries.length <= turns)
  log('a finished run records what it cost, for both viewers')

  // Reverting takes the last exchange out of the real history, not just the
  // screen — the next run must not still see the prompt that was withdrawn.
  const beforeRevert = (await api('/api/session/'+sessionId)).messages.length
  const reverted = await api('/api/revert',{sessionId})
  assert.equal(typeof reverted.prompt, 'string')
  const afterRevert = (await api('/api/session/'+sessionId)).messages
  assert(afterRevert.length < beforeRevert)
  assert(!afterRevert.some(m=>m.blocks.some(b=>b.type==='text' && b.text===reverted.prompt)))
  log('reverting drops the last exchange from the real history')
  const before = await api('/api/session/'+sessionId)
  assert(before.messages.length>0)
  await window.reload()
  await window.getByRole('button',{name:'desktop-first',exact:true}).waitFor()
  await window.getByRole('button',{name:'desktop-first',exact:true}).click()
  await window.getByText('Fixture reply: desktop-first',{exact:true}).waitFor()
  log('desktop reload restores main-process conversations')
  await window.getByPlaceholder('Ask anything…').fill('unsent draft')
  await window.getByRole('button',{name:'third parallel',exact:true}).click()
  await window.getByRole('button',{name:'desktop-first',exact:true}).click()
  assert.equal(await window.getByPlaceholder('Ask anything…').inputValue(),'unsent draft')
  log('drafts survive tab switches')
  await window.getByPlaceholder('Ask anything…').fill('')
  await window.evaluate(()=>window.anticode.selectProvider({provider:'clinepass',model:'test-model-2'}))
  await window.getByPlaceholder('Ask anything…').fill('after model switch')
  await window.getByPlaceholder('Ask anything…').press('Enter')
  await window.getByText('Fixture reply: after model switch',{exact:true}).waitFor()
  const specs = await window.evaluate(()=>window.anticode.listSessions())
  const first = await window.evaluate(async (ids) => {
    for (const spec of ids) {
      const snapshot = await window.anticode.getSessionSnapshot(spec.sessionId)
      const messages = snapshot?.messages ?? []
      if (messages.some(m=>m.blocks.some(b=>b.type==='text' && b.text==='desktop-first'))) return messages
    }
    return []
  }, specs)
  assert(first.some(m=>m.blocks.some(b=>b.type==='text' && b.text==='after model switch')))
  log('changing model preserves completed conversation history')
  await app.close()
  app = await electron.launch({args:[bootstrap],env,cwd:directory})
  window = await app.firstWindow()
  window.on('pageerror',error=>errors.push(error.message))
  await window.getByRole('button',{name:'desktop-first',exact:true}).waitFor()
  await window.getByRole('button',{name:'desktop-first',exact:true}).click()
  await window.getByText('Fixture reply: desktop-first',{exact:true}).waitFor()
  await window.getByText('Fixture reply: after model switch',{exact:true}).waitFor()
  log('full app restart restores sessions and conversation history')
  // The closing line used to vanish on reload, because only the renderer knew
  // what a run had cost. It is written down now, so it comes back too.
  const restored = await window.evaluate(async () => {
    const specs = await window.anticode.listSessions()
    for (const spec of specs) {
      const snapshot = await window.anticode.getSessionSnapshot(spec.sessionId)
      if ((snapshot?.summaries ?? []).length > 0) return snapshot.summaries
    }
    return []
  })
  assert(restored.length > 0)
  assert(restored.every(s=>typeof s.model==='string' && typeof s.durationMs==='number' && s.inputTokens+s.outputTokens>0))
  const shown = await window.evaluate(()=>window.__store.getState().sessions.flatMap(s=>s.messages).filter(m=>m.summary!==undefined).length)
  assert(shown > 0)
  log('a restart brings the closing line back with the transcript')

  // The phone UI, driven for real against the running server rather than a
  // stub. It had no coverage at all until a card that could not be dismissed
  // turned out to be a CSS specificity bug: an id rule setting `display`
  // outranks `.hidden`, pinning the element on screen forever.
  const phone = await chromium.launch()
  try {
    const screen = await phone.newPage({ viewport: { width: 390, height: 844 } })
    const phoneErrors = []
    screen.on('pageerror', (error) => phoneErrors.push(error.message))
    await screen.goto(`http://127.0.0.1:18680/?token=${remote.token}`)
    await screen.waitForTimeout(600)

    const stuck = await screen.evaluate(() => {
      const ids = ['menuDrop','errorBanner','chatView','viewFiles','inputRow','stagedRow','quoteRow',
                   'fileInput','editor','gitOut','approvalPanel','replyBtn','useModelBtn',
                   'dashboard','sessionList','newSessionCard']
      return ids.filter((id) => {
        const el = document.getElementById(id)
        if (el === null) return false
        el.classList.add('hidden')
        return getComputedStyle(el).display !== 'none'
      })
    })
    assert.deepEqual(stuck, [], `these refuse to hide: ${stuck.join(', ')}`)
    log('every element the phone hides actually hides')

    await screen.reload()
    await screen.waitForTimeout(600)
    await screen.evaluate((id) => openSession(id), sessionId)
    await screen.waitForSelector('#transcript .msg', { timeout: 10000 })
    const quoted = await screen.evaluate(() => {
      const node = [...document.querySelectorAll('#transcript .msg')].find((el) => el.textContent.trim() !== '')
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return node.textContent.trim().slice(0, 20)
    })
    await screen.waitForTimeout(300)
    assert.equal(await screen.$eval('#replyBtn', (el) => getComputedStyle(el).display !== 'none'), true)
    // Under the selection and out of the way: iOS lays its own Salin / Temukan
    // Pilihan / Terjemahkan bar over the top edge of a selection.
    const placement = await screen.evaluate(() => {
      const button = document.getElementById('replyBtn').getBoundingClientRect()
      const range = window.getSelection().getRangeAt(0).getBoundingClientRect()
      const composer = document.getElementById('inputRow').getBoundingClientRect()
      const style = getComputedStyle(document.getElementById('replyBtn'))
      return { below: button.top > range.bottom, clear: button.bottom <= composer.top,
               bg: style.backgroundColor, colour: style.color }
    })
    assert.equal(placement.below, true, 'the reply button must sit below the selection')
    assert.equal(placement.clear, true, 'the reply button must stay clear of the composer')
    assert.equal(placement.bg, 'rgb(209, 250, 34)')
    assert.equal(placement.colour, 'rgb(26, 26, 26)')

    // iOS drops the selection the instant the button is tapped, so the text has
    // to be kept from when it was selected — reading it back finds nothing.
    await screen.evaluate(() => {
      window.getSelection().removeAllRanges()
      document.getElementById('replyBtn').classList.remove('hidden')
      document.getElementById('replyBtn').dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    await screen.waitForTimeout(300)
    assert.equal(await screen.$eval('#quoteRow', (el) => getComputedStyle(el).display !== 'none'), true)
    assert.match(await screen.$eval('#quoteText', (el) => el.textContent), new RegExp(quoted.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await screen.click('#quoteRow .qx')
    await screen.waitForTimeout(300)
    assert.equal(await screen.$eval('#quoteRow', (el) => getComputedStyle(el).display === 'none'), true)
    assert.deepEqual(phoneErrors, [])
    log('the phone quotes a selected passage, and the card can be dismissed')

    // An attached picture opens in the phone too, at full size — the thumbnail
    // is unreadable for the screenshots people actually send.
    const shot = await screen.evaluate(() => {
      const image = document.querySelector('#transcript .att img')
      if (image === null) return null
      image.click()
      const viewer = document.getElementById('imgViewer')
      return { open: !viewer.classList.contains('hidden'), name: document.getElementById('imgName').textContent }
    })
    assert.notEqual(shot, null, 'no attached picture in the phone transcript')
    assert.equal(shot.open, true)
    assert.equal(shot.name, 'layar.png')
    const picturePath = (await api('/api/session/'+sessionId)).messages
      .flatMap(m=>m.blocks)
      .find(b=>b.type==='attachment' && b.attachment.name==='layar.png').attachment.path
    const served = await fetch(`http://127.0.0.1:18680/api/attachment?sessionId=${sessionId}` +
      `&path=${encodeURIComponent(picturePath)}&token=${remote.token}`)
    assert.equal(served.status, 200)
    assert.equal(served.headers.get('content-type'), 'image/png')
    const outside = await fetch(`http://127.0.0.1:18680/api/attachment?sessionId=${sessionId}` +
      `&path=${encodeURIComponent('/etc/hosts')}&token=${remote.token}`)
    assert.equal(outside.status, 400)
    await screen.evaluate(() => closeImage())
    assert.equal(await screen.$eval('#imgViewer', (el) => getComputedStyle(el).display === 'none'), true)
    log('an attached picture opens on the phone, and only its own files are served')
  } finally {
    await phone.close()
  }
  assert.deepEqual(errors,[])
  log('no renderer exceptions')
  console.log(JSON.stringify({directory,workspace,remoteUrl:`http://127.0.0.1:18680/?token=${remote.token}`,calls}))
  if (process.argv.includes('--keep-open')) {
    const { existsSync } = await import('node:fs')
    await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(path.join(directory, 'finish'))) { clearInterval(timer); resolve() } }, 500) })
  }
} catch (error) {
  console.error('UI at failure:',await window.locator('body').innerText());
  console.error('Run state:',await window.evaluate(()=>({runs:window.__store.getState().activeRuns, mirrors:window.__store.getState().mirrorRuns,paused:window.__store.getState().pausedSessions}))); 
  await window.screenshot({path:path.join(directory,'failure.png')});
  throw error
} finally {
  await app.close(); await new Promise(r=>stub.close(r))
}
