// Run after npm run build. Uses a temporary profile, fixture workspace and local
// OpenAI-compatible stub; never reads account credentials or calls paid APIs.
import { _electron as electron, chromium } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import ExcelJS from 'exceljs'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-verification-'))
const profile = path.join(directory, 'profile')
const { mkdir } = await import('node:fs/promises')
await mkdir(profile)
const workspace = path.join(directory, 'workspace'); await mkdir(workspace)
await writeFile(path.join(workspace, 'hello.txt'), 'original')
await writeFile(path.join(workspace, '<b>literal.txt'), 'literal filename')
let calls = 0
/** What the stub was last sent, so a test can read the framing the model saw. */
let lastSent = ''
/** A page for the browser pane to point at, standing in for a dev server. */
async function createStaticPage() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Halaman Lokal</title><style>body{margin:0}main{height:1800px;background:linear-gradient(white,lightblue)}@media(min-width:600px){main{background:red}}</style><main><h1>Halaman Lokal</h1></main><footer>End of page</footer>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const stub = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:'test-model'},{id:'test-model-2'}]})); return }
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw); calls++
  const prompt = body.messages.filter(m=>m.role==='user').at(-1)?.content
  const text = typeof prompt === 'string' ? prompt : prompt?.filter(p=>p.type==='text').map(p=>p.text).join(' ') ?? ''
  lastSent = JSON.stringify(body.messages)
  if (text.includes('provider-error')) { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'Fixture provider rejected the request'}})); return }
  res.writeHead(200, {'content-type':'text/event-stream'})
  const chunk = (delta, finish_reason=null) => res.write(`data: ${JSON.stringify({id:'test',choices:[{index:0,delta,finish_reason}]})}\n\n`)
  // Only the turn that opens the run: once the tool has answered, reply in words.
  if (text.includes('format-fixture') && body.messages.at(-1)?.role !== 'tool') {
    chunk({tool_calls:[{index:0,id:'format-test',type:'function',function:{name:'format_excel_cells',arguments:JSON.stringify({path:'.anticode/uploads/Template_Import_Data_Barang.xlsx',range:'A1:B1',fill:'#C00000',output_path:'.anticode/uploads/Template_Import_Data_Barang-merah.xlsx'})}}]})
    chunk({}, 'tool_calls')
  } else if (text.includes('write-fixture') && !body.messages.some(m=>m.role==='tool')) {
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
  await window.getByPlaceholder(/just vibes/).fill('desktop-first')
  await window.getByPlaceholder(/just vibes/).press('Enter')
  await window.getByText('Fixture reply: desktop-first',{exact:true}).waitFor()
  log('desktop chat streams and completes')
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.getByPlaceholder(/just vibes/).fill('slow second')
  await window.getByPlaceholder(/just vibes/).press('Enter')
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.getByPlaceholder(/just vibes/).fill('third parallel')
  await window.getByPlaceholder(/just vibes/).press('Enter')
  await window.getByText('Fixture reply: third parallel',{exact:true}).waitFor()
  await window.getByRole('button',{name:'slow second',exact:true}).click()
  await window.getByText('Fixture reply: slow second',{exact:true}).waitFor()
  assert.equal(await window.getByText('working',{exact:true}).count(),0)
  log('two desktop sessions finish independently')
  await window.getByPlaceholder("Don't work today, just vibes.").fill('slow cancel')
  await window.getByPlaceholder("Don't work today, just vibes.").press('Enter')
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
  // A second prompt no longer bounces off a working session: from either
  // device it joins the run that is going, rather than starting a rival one.
  const phoneJoin = await api('/api/prompt', {sessionId,prompt:'duplicate'})
  assert.deepEqual([phoneJoin.runId, phoneJoin.steered], [remoteRun.runId, true])
  const desktopJoin = await window.evaluate(({sessionId}) => window.anticode.sendPrompt({sessionId,runId:crypto.randomUUID(),prompt:'duplicate desktop',attachmentIds:[]}), {sessionId})
  assert.deepEqual([desktopJoin.runId, desktopJoin.steered], [remoteRun.runId, true])
  await window.evaluate((runId)=>window.anticode.cancelRun(runId),remoteRun.runId)
  for (let i=0;i<50;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  assert.equal((await api('/api/session/'+sessionId)).runId,null)
  // Paused before it could take them in, the two follow-ups are kept, not lost.
  const kept = (await api('/api/session/'+sessionId)).messages.flatMap((m) => m.blocks)
    .filter((b) => b.type === 'text' && b.followUp === 'after').map((b) => b.text)
  assert.deepEqual(kept, ['duplicate', 'duplicate desktop'])
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
  // In a code session the upload is copied into the project, where tools reach it.
  assert(uploadHistory.some(m=>m.blocks.some(b=>b.type==='attachment' && b.attachment.name==='layar.png' &&
    b.attachment.workspacePath===path.join('.anticode','uploads','layar.png'))))
  assert.equal(await readFile(path.join(workspace,'.anticode','.gitignore'),'utf8'),'*\n')

  // The whole request from the phone: a blue-headed template goes up, the
  // agent recolours it, and the result comes back down as a download.
  const template = new ExcelJS.Workbook()
  const importSheet = template.addWorksheet('Import Data')
  importSheet.addRow(['NO. PART','NAMA','RSV'])
  for (const address of ['A1','B1','C1']) importSheet.getCell(address).fill = {type:'pattern',pattern:'solid',fgColor:{argb: address==='C1' ? 'FF808080' : 'FF1F4E78'}}
  const templateUpload = await api('/api/attachment',{name:'Template_Import_Data_Barang.xlsx',data:Buffer.from(await template.xlsx.writeBuffer()).toString('base64')})
  await api('/api/prompt',{sessionId,prompt:'format-fixture: ubah header biru jadi merah',attachmentIds:[templateUpload.id]})
  await window.getByRole('button',{name:'Approve',exact:true}).waitFor()
  // The model saw which cells are blue before it was asked to change them.
  assert.match(lastSent, /Formatting \(fill is the background colour\):\\n- A1:B1 fill #1F4E78/)
  await window.getByRole('button',{name:'Approve',exact:true}).click()
  for (let i=0;i<100;i++) { if (!(await api('/api/session/'+sessionId)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  const recoloured = await fetch(`http://127.0.0.1:18680/api/download?sessionId=${sessionId}&path=${encodeURIComponent('.anticode/uploads/Template_Import_Data_Barang-merah.xlsx')}&token=${remote.token}`)
  assert.equal(recoloured.status,200)
  const result = new ExcelJS.Workbook(); await result.xlsx.load(Buffer.from(await recoloured.arrayBuffer()))
  assert.deepEqual(['A1','B1','C1'].map(a=>result.worksheets[0].getCell(a).fill.fgColor.argb), ['FFC00000','FFC00000','FF808080'])
  log('a phone upload lands in .anticode/uploads, is recoloured by format_excel_cells, and downloads back')

  // antichat: told it has only the preview, and the session is named after
  // the words typed, not after the file that rode ahead of them.
  const chatSession = (await api('/api/session',{mode:'chat'})).sessionId
  const receipt = await api('/api/attachment',{name:'Receipt-2844-21.txt',data:Buffer.from('Total 125000').toString('base64')})
  await api('/api/prompt',{sessionId:chatSession,prompt:'Ringkas struk ini',attachmentIds:[receipt.id]})
  for (let i=0;i<100;i++) { if (!(await api('/api/session/'+chatSession)).runId) break; await new Promise(r=>setTimeout(r,20)) }
  assert.match(lastSent, /antichat, which has no tools/)
  assert.equal((await api('/api/overview')).sessions.find(s=>s.id===chatSession).title, 'Ringkas struk ini')
  await fetch(`http://127.0.0.1:18680/api/session/${chatSession}?token=${remote.token}`,{method:'DELETE'})
  log('antichat is told what an attachment is to it, and names the session after the prompt')
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
  await window.getByPlaceholder("Don't work today, just vibes.").fill('unsent draft')
  await window.getByRole('button',{name:'third parallel',exact:true}).click()
  await window.getByRole('button',{name:'desktop-first',exact:true}).click()
  assert.equal(await window.getByPlaceholder("Don't work today, just vibes.").inputValue(),'unsent draft')
  log('drafts survive tab switches')
  await window.getByPlaceholder("Don't work today, just vibes.").fill('')
  await window.evaluate(()=>window.anticode.selectProvider({provider:'clinepass',model:'test-model-2'}))
  await window.getByPlaceholder("Don't work today, just vibes.").fill('after model switch')
  await window.getByPlaceholder("Don't work today, just vibes.").press('Enter')
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
  // A page the session had open is part of the session: it comes back with it,
  // so relaunching lands on the same local server the last run was watching.
  await window.evaluate((id) => window.anticode.openWebUrl(id, 'http://127.0.0.1:4173/orders'), sessionId)
  await app.close()
  app = await electron.launch({args:[bootstrap],env,cwd:directory})
  window = await app.firstWindow()
  window.on('pageerror',error=>errors.push(error.message))
  await window.getByRole('button',{name:'desktop-first',exact:true}).waitFor()
  await window.getByRole('button',{name:'desktop-first',exact:true}).click()
  await window.getByText('Fixture reply: desktop-first',{exact:true}).waitFor()
  await window.getByText('Fixture reply: after model switch',{exact:true}).waitFor()
  log('full app restart restores sessions and conversation history')
  const restoredPane = await window.evaluate(async (id) =>
    (await window.anticode.listWebSessions()).find((entry) => entry.sessionId === id), sessionId)
  assert.deepEqual(restoredPane?.tabs.map((tab) => tab.url), ['http://127.0.0.1:4173/orders'])
  assert.equal(restoredPane?.hidden, false)
  log('a restart reopens the page the session had open')
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
      const ids = ['menuDrop','errorBanner','chatView','viewFiles','viewWeb','webFrame','webLoading','inputRow','stagedRow','quoteRow',
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

    // The Web screen sits between Sessions and Files in the one dropdown, and
    // shows the page the desktop has beside its transcript. The phone cannot
    // embed it — every localhost the agent serves lives on the Mac — so what
    // it gets is a separate mobile rendering of the active URL.
    const menuOrder = await screen.evaluate(() =>
      [...document.querySelectorAll('#menuDrop .mrow')].map((el) => el.textContent.trim()))
    assert.deepEqual(menuOrder, ['New session','Sessions','Web','Files','Settings'])

    const page = await createStaticPage()
    try {
      await window.evaluate(([id, url]) => window.anticode.openWebUrl(id, url), [sessionId, page.origin])
      await screen.evaluate(() => gotoWeb())
      await screen.waitForTimeout(800)
      assert.equal(await screen.$eval('#viewWeb', (el) => getComputedStyle(el).display !== 'none'), true)
      assert.equal(await screen.$eval('#inputRow', (el) => getComputedStyle(el).display === 'none'), true)
      assert.match(await screen.$eval('#webNote', (el) => el.textContent), new RegExp(page.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.equal(await screen.$eval('#webSession', (el) => el.value), sessionId)

      const picture = await fetch(`http://127.0.0.1:18680/api/web/shot?sessionId=${sessionId}&token=${remote.token}`)
      assert.equal(picture.status, 200)
      assert.equal(picture.headers.get('content-type'), 'image/jpeg')
      const bytes = Buffer.from(await picture.arrayBuffer())
      const size = await sharp(bytes).metadata()
      // Rendered at a phone's width and its whole height — something to scroll
      // with a thumb, not a desktop page shrunk to a postage stamp.
      assert.equal(size.width, 780)
      assert.ok(size.height > size.width, `the page picture is not phone-shaped: ${size.width}x${size.height}`)
      await screen.waitForFunction(() => document.getElementById('webShot').naturalWidth > 0, null, { timeout: 15000 })
      const drawn = await screen.$eval('#webShot', (el) => ({
        width: el.getBoundingClientRect().width,
        viewport: window.innerWidth
      }))
      assert.ok(drawn.width >= drawn.viewport - 2, `the page is not drawn edge to edge: ${drawn.width}px of ${drawn.viewport}`)
      const scroll = await screen.evaluate(() => {
        const main = document.scrollingElement;
        main.scrollTop = main.scrollHeight;
        return { top: main.scrollTop, height: main.clientHeight, total: main.scrollHeight };
      })
      assert.ok(scroll.top > 500 && scroll.total > scroll.height, 'the mobile page must scroll beyond the first screen')
      await screen.screenshot({ path: path.join(directory, 'phone-web-scrolled.png') })
      await screen.evaluate(() => { document.scrollingElement.scrollTop = 0 })
      await screen.screenshot({ path: path.join(directory, 'phone-web.png') })
      assert.equal(await screen.$$eval('#menuDrop .mrow span', (els) => els.length), 0, 'the Web row carries a dot')
      log('the phone renders the session page at phone width, edge to edge')

      // Tabs reach the phone too: a new one appears as a chip and can be closed.
      await screen.evaluate(() => document.querySelector('#webTabs .wadd').click())
      await screen.waitForTimeout(500)
      assert.equal(await screen.$$eval('#webTabs .wtab', (els) => els.length), 2)
      await screen.evaluate(() => [...document.querySelectorAll('#webTabs .wtab .wx')].at(-1).click())
      await screen.waitForTimeout(500)
      assert.equal(await screen.$$eval('#webTabs .wtab', (els) => els.length), 1)
      log('the phone opens and closes tabs')

      // Hiding is one decision the whole app shares: hidden on the phone is
      // hidden beside the transcript too, and it stays that way until asked.
      await screen.evaluate(() => toggleWebHidden())
      await screen.waitForTimeout(400)
      assert.equal(await screen.$eval('#webHideBtn', (el) => el.textContent), 'Show')
      const paneOf = () => window.evaluate(async (id) =>
        (await window.anticode.listWebSessions()).find((entry) => entry.sessionId === id), sessionId)
      assert.equal((await paneOf()).hidden, true)
      await screen.evaluate(() => toggleWebHidden())
      await screen.waitForTimeout(400)
      assert.equal((await paneOf()).hidden, false)
      log('the phone can hide and show the session page')

      // Back and Forward, which the desktop pane has, from the phone too.
      await window.evaluate(([id, url]) => window.anticode.openWebUrl(id, url), [sessionId, page.origin + '/two'])
      await screen.evaluate(() => refreshWebList())
      await screen.waitForFunction(() => !document.getElementById('webBackBtn').disabled, null, { timeout: 5000 })
      await screen.click('#webBackBtn')
      const activeUrl = async () => {
        const pane = await paneOf()
        return pane.tabs.find((tab) => tab.id === pane.activeTabId).url.replace(/\/$/, '')
      }
      assert.equal(await activeUrl(), page.origin)
      await screen.waitForFunction(() => !document.getElementById('webFwdBtn').disabled, null, { timeout: 5000 })
      await screen.click('#webFwdBtn')
      assert.equal(await activeUrl(), page.origin + '/two')
      const navFits = await screen.$$eval('#viewWeb .actions button', (els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1))
      assert.ok(navFits, 'a Web action button is cut off')
      await screen.screenshot({ path: path.join(directory, 'phone-web-nav.png') })
      log('the phone steps Back and Forward, and the desktop pane follows')

      // The same colour on both screens: the phone's overview carries the
      // index the desktop paints with, and its badge wears that palette entry.
      const overview = await api('/api/overview')
      const desktopColour = await window.evaluate((id) =>
        window.__store.getState().sessions.find((s) => s.id === id)?.colour, sessionId)
      const phoneColour = overview.sessions.find((s) => s.id === sessionId)?.colour
      assert.equal(phoneColour, desktopColour, 'the phone and the desktop paint this session differently')
      log('the phone paints each session in the desktop colour')
    } finally {
      await new Promise((resolve) => page.server.close(resolve))
    }
    // Typing on the phone: the glass shell keeps its neutral hairline — no
    // lime ring, and no browser blue ring around the text field either.
    await screen.evaluate((id) => openSession(id), sessionId)
    await screen.waitForSelector('#transcript .msg', { timeout: 10000 })

    // A picture staged above the box opens full size before it is sent, from
    // the phone's own copy — the same viewer a sent one opens in.
    const compactComposerHeight = await screen.$eval('#inputRow', (el) => el.getBoundingClientRect().height)
    const stagedPicture = await sharp({create:{width:300,height:200,channels:3,background:'#3f7fc2'}}).png().toBuffer()
    await screen.setInputFiles('#fileInput', { name: 'staged.png', mimeType: 'image/png', buffer: stagedPicture })
    await screen.waitForSelector('#stagedRow .chip.pic', { timeout: 10000 })
    const attachedComposer = await screen.evaluate(() => ({
      height: document.getElementById('inputRow').getBoundingClientRect().height,
      inside: document.getElementById('inputRow').contains(document.querySelector('#stagedRow .chip'))
    }))
    assert.equal(attachedComposer.inside, true)
    assert.ok(attachedComposer.height > compactComposerHeight, 'an attachment did not grow the glass composer')
    await screen.screenshot({ path: path.join(directory, 'phone-composer-attachment.png') })
    await screen.click('#stagedRow .chip.pic')
    const stagedView = await screen.evaluate(() => ({
      open: !document.getElementById('imgViewer').classList.contains('hidden'),
      name: document.getElementById('imgName').textContent,
      local: document.getElementById('imgFull').src.startsWith('blob:')
    }))
    assert.deepEqual(stagedView, { open: true, name: 'staged.png', local: true })
    await screen.evaluate(() => { closeImage(); document.querySelector('#stagedRow .x').click() })
    assert.equal(await screen.$$eval('#stagedRow .chip', (els) => els.length), 0)
    log('a staged picture opens full size on the phone before it is sent')
    await screen.focus('#prompt')
    const ring = await screen.evaluate(() => {
      const field = getComputedStyle(document.getElementById('prompt'))
      const shell = getComputedStyle(document.getElementById('inputRow'))
      return { border: shell.borderTopColor, outline: field.outlineStyle }
    })
    assert.equal(ring.border, 'rgba(255, 255, 255, 0.14)')
    assert.equal(ring.outline, 'none')
    await screen.fill('#prompt', 'baris satu\nbaris dua\nbaris tiga')
    assert.ok(await screen.$eval('#prompt', (el) => el.getBoundingClientRect().height) > 48)
    await screen.fill('#prompt', '')
    log('the phone prompt stays neutral while typed in')

    // A prompt sent while the session works joins that run. The box empties
    // the moment it is sent, the button is the desktop's own square to pause
    // and arrow to send, and the reaction is written in the same words.
    const slow = await api('/api/prompt', { sessionId, prompt: 'slow phone work' })
    await screen.waitForFunction(() => currentRunId !== null, null, { timeout: 5000 })
    const pauseGlyph = await screen.$eval('#sendBtn', (el) => {
      const square = el.querySelector('.sq')
      if (square === null) return null
      const style = getComputedStyle(square)
      return { width: style.width, height: style.height, radius: style.borderTopLeftRadius, label: el.getAttribute('aria-label') }
    })
    assert.deepEqual(pauseGlyph, { width: '10px', height: '10px', radius: '2px', label: 'Pause' })
    await screen.fill('#prompt', 'tambah dari hp')
    assert.equal(await screen.$eval('#sendBtn', (el) => el.getAttribute('aria-label')), 'Send')
    assert.equal(await screen.$eval('#sendBtn', (el) => el.querySelector('svg') !== null), true)
    const cleared = await screen.evaluate(() => {
      const pending = sendPrompt()
      const now = document.getElementById('prompt').value
      return pending.then(() => now)
    })
    assert.equal(cleared, '', 'the phone kept the sent prompt in the box')
    await screen.waitForFunction((label) =>
      [...document.querySelectorAll('#transcript .notice')].some((el) => el.textContent === label),
      'wait a minutes, bi***', { timeout: 5000 })
    const desktopSaw = await window.evaluate(async ([id, runId]) => {
      for (let i = 0; i < 50; i++) {
        const session = window.__store.getState().sessions.find((s) => s.id === id)
        const said = session.messages.some((m) => m.parts.some((p) => p.kind === 'notice' && p.text === 'wait a minutes, bi***'))
        const typed = session.messages.some((m) => m.role === 'user' && m.parts.some((p) => p.kind === 'text' && p.text === 'tambah dari hp'))
        if (said && typed) return runId
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return null
    }, [sessionId, slow.runId])
    assert.equal(desktopSaw, slow.runId, 'the desktop never showed the phone follow-up')
    await screen.waitForFunction(() => currentRunId === null, null, { timeout: 15000 })
    const snapshot = await api('/api/session/' + sessionId)
    const followUp = snapshot.messages.flatMap((m) => m.blocks).find((b) => b.type === 'text' && b.text === 'tambah dari hp')
    assert.equal(followUp?.followUp, 'during', 'the run did not take the phone follow-up in')
    log('a phone prompt sent mid-run joins the run, on both screens')

    // A live snapshot must retain deltas emitted before the request. Previously
    // a refresh replaced them with the agent's unfinished persisted transcript.
    await api('/api/prompt', { sessionId, prompt: 'slow snapshot recovery' })
    await screen.waitForFunction(() => currentRunId !== null)
    // The transcript already holds earlier "Fixture reply:" turns, so waiting
    // on the screen text passed before this run had streamed anything. The
    // stub holds the run open for two seconds after its first words; the main
    // process must be holding those words for a snapshot well within that.
    let snapshotBefore
    for (let i = 0; i < 30; i++) {
      snapshotBefore = await api('/api/session/' + sessionId)
      if (snapshotBefore.events.some((event) => event.type === 'text_delta')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(snapshotBefore.runId !== null, 'the run finished before its live text could be checked')
    assert.ok(snapshotBefore.events.some((event) => event.type === 'text_delta'), 'main process lost live text')
    await screen.evaluate((id) => syncSession(id), sessionId)
    assert.match(await screen.locator('#transcript').innerText(), /Fixture reply:/)
    // Reopening the desktop during that same run must replay the same prefix.
    await window.reload()
    await window.waitForFunction((id) => {
      const state = window.__store?.getState()
      return state?.sessions.find((session) => session.id === id)?.messages.some((message) =>
        message.pending && message.parts.some((part) => part.kind === 'text' && part.text.includes('Fixture reply:')))
    }, sessionId)
    await screen.waitForFunction(() => currentRunId === null, null, { timeout: 15000 })
    const recovered = await screen.locator('#transcript').innerText()
    assert.equal((recovered.match(/Fixture reply: slow snapshot recovery/g) ?? []).length, 1)
    log('live phone sync and desktop reload recover streaming text exactly once')

    // Simultaneous admissions use one main-process owner, regardless of transport.
    const simultaneous = await Promise.all([
      window.evaluate((id) => window.anticode.sendPrompt({ sessionId: id, runId: crypto.randomUUID(), prompt: 'slow simultaneous desktop', attachmentIds: [] }), sessionId),
      api('/api/prompt', { sessionId, prompt: 'slow simultaneous phone' })
    ])
    assert.equal(simultaneous[0].runId, simultaneous[1].runId)
    assert.equal(simultaneous.filter((result) => result.steered).length, 1)
    await screen.waitForFunction(() => currentRunId === null, null, { timeout: 15000 })
    log('simultaneous desktop and phone prompts share one run')

    // One pause, owned by the main process: pressed on either screen, both
    // show Resume, and either one can press it. Each used to keep its own, so
    // a pause from the phone could not be resumed on the desktop.
    const desktopPaused = () => window.evaluate((id) => window.__store.getState().pausedSessions[id] === true, sessionId)
    const phonePaused = () => screen.evaluate((id) => pausedSessions.has(id), sessionId)
    const phoneButton = () => screen.$eval('#sendBtn', (el) => el.getAttribute('aria-label'))
    const until = async (check, what) => {
      for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)) }
      throw new Error(`timed out waiting for ${what}`)
    }
    await window.evaluate((id) => window.__store.getState().selectSession(id), sessionId)
    await window.evaluate((id) => window.anticode.sendPrompt({ sessionId: id, runId: crypto.randomUUID(), prompt: 'slow desktop work', attachmentIds: [] }), sessionId)
    await screen.waitForFunction(() => currentRunId !== null, null, { timeout: 5000 })
    await screen.click('#sendBtn')
    await until(desktopPaused, 'the desktop to hear of the phone pause')
    await until(async () => (await phoneButton()) === 'Resume', 'the phone Resume button')
    await window.getByRole('button', { name: 'Resume', exact: true }).waitFor()
    await window.getByRole('button', { name: 'Resume', exact: true }).click()
    await until(async () => !(await phonePaused()), 'the phone to hear of the desktop resume')
    await until(async () => !(await desktopPaused()), 'the desktop resume to end the pause')
    await screen.waitForFunction(() => currentRunId === null, null, { timeout: 15000 })
    assert.notEqual(await phoneButton(), 'Resume')
    log('paused on the phone, resumed on the desktop')

    await api('/api/prompt', { sessionId, prompt: 'slow phone run' })
    await window.getByRole('button', { name: 'Pause', exact: true }).waitFor()
    await window.getByRole('button', { name: 'Pause', exact: true }).click()
    await until(phonePaused, 'the phone to hear of the desktop pause')
    await until(async () => (await phoneButton()) === 'Resume', 'the phone Resume button after a desktop pause')
    await screen.click('#sendBtn')
    await until(async () => !(await desktopPaused()), 'the desktop to hear of the phone resume')
    await screen.waitForFunction(() => currentRunId === null && !pausedSessions.has(currentSession), null, { timeout: 15000 })
    await window.getByRole('button', { name: 'Resume', exact: true }).waitFor({ state: 'detached' })
    log('paused on the desktop, resumed on the phone')

    // A run that already finished has nothing to pause: pressing a stale Pause
    // must not leave a Resume button on either screen.
    assert.deepEqual(await api('/api/pause', { sessionId }), { paused: false })
    assert.equal(await window.evaluate((id) => window.anticode.pauseSession(id), sessionId), false)
    assert.equal((await api('/api/session/' + sessionId)).paused, false)
    assert.equal(await desktopPaused(), false)
    log('pausing a finished run leaves nothing to resume')

    // A turn reverted on the desktop is gone from the phone's screen too.
    await api('/api/prompt', { sessionId, prompt: 'to be reverted' })
    await screen.waitForFunction(() => document.getElementById('transcript').textContent.includes('Fixture reply: to be reverted'), null, { timeout: 10000 })
    await screen.waitForFunction(() => currentRunId === null, null, { timeout: 10000 })
    assert.equal(await window.evaluate((id) => window.anticode.revertLastTurn(id), sessionId), 'to be reverted')
    await screen.waitForFunction(() => !document.getElementById('transcript').textContent.includes('to be reverted'), null, { timeout: 5000 })
    log('a turn reverted on the desktop disappears from the phone')

    // Model selection follows the main process while the chat remains open.
    await window.evaluate(() => window.anticode.selectProvider({ provider: 'clinepass', model: 'test-model' }))
    await screen.waitForFunction(() => modelInfo?.model === 'test-model')
    const longModel = 'claude-opus-thinking-with-a-very-long-context-name'
    await window.evaluate((model) => window.anticode.selectProvider({ provider: 'clinepass', model }), longModel)
    await screen.waitForFunction((model) => modelInfo?.model === model, longModel)
    await screen.waitForFunction(() => document.getElementById('modelChip').classList.contains('clipped'))
    const modelWidth = await screen.$eval('#modelChip', (el) => el.getBoundingClientRect().width)
    assert.ok(modelWidth <= 390 * .45, 'the long model steals more than half the phone composer')
    log('desktop model changes reach the open phone chat')

    await screen.evaluate(() => gotoFiles())
    await screen.waitForFunction((id) => document.getElementById('folderSession').value === id, sessionId)
    const openedFile = await api('/api/files?sessionId=' + sessionId + '&path=hello.txt')
    const savedFile = await api('/api/files', { sessionId, path: 'hello.txt', version: openedFile.version, content: 'edited from phone' })
    assert.notEqual(savedFile.version, openedFile.version)
    assert.equal(await readFile(path.join(workspace, 'hello.txt'), 'utf8'), 'edited from phone')
    await assert.rejects(api('/api/files', { sessionId, path: 'hello.txt', version: openedFile.version, content: 'stale overwrite' }), /File changed/)
    log('phone editor selects the current project, saves, and refuses stale writes')
    await screen.evaluate((id) => openSession(id), sessionId)
    await screen.waitForSelector('#transcript .msg')
    for (const viewport of [{ width: 360, height: 800 }, { width: 430, height: 932 }, { width: 844, height: 390 }]) {
      await screen.setViewportSize(viewport)
      const layout = await screen.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
        composer: document.getElementById('inputRow').getBoundingClientRect().toJSON() }))
      assert.ok(layout.content <= layout.width + 1, 'phone content overflows at ' + viewport.width)
      assert.ok(layout.composer.width > 0 && layout.composer.right <= viewport.width + 1)
    }
    await screen.setViewportSize({ width: 390, height: 844 })
    const glass = await screen.evaluate(() => {
      const header = getComputedStyle(document.querySelector('header'))
      const fade = document.querySelectorAll('header .hfade i')
      const glyph = (el) => { const style = getComputedStyle(el); return style.backgroundColor + ' ' + style.borderTopColor }
      const composer = document.getElementById('inputRow')
      const box = composer.getBoundingClientRect()
      const shell = getComputedStyle(composer)
      const model = document.getElementById('modelChip')
      return {
        headerBorder: header.borderBottomWidth,
        headerShadow: header.boxShadow,
        fadeLayers: fade.length,
        fadeBlur: getComputedStyle(fade[fade.length - 1]).backdropFilter,
        fadeMask: getComputedStyle(fade[fade.length - 1]).maskImage,
        fadeReach: document.querySelector('header .hfade').getBoundingClientRect().bottom - document.querySelector('header').getBoundingClientRect().bottom,
        menuButton: glyph(document.getElementById('menuBtn')),
        attachButton: glyph(document.getElementById('attachBtn')),
        composerBlur: shell.backdropFilter,
        composerBackground: shell.backgroundColor,
        bottomGap: innerHeight - box.bottom,
        modelMask: getComputedStyle(model.querySelector('.modelText')).maskImage,
        modelOverlay: getComputedStyle(model, '::after').content
      }
    })
    // The header has no edge: no border, no shadow, and a blur that thins out
    // to nothing a little below it.
    assert.equal(glass.headerBorder, '0px', 'the phone header has a bottom edge again')
    assert.equal(glass.headerShadow, 'none', 'the phone header casts a shadow edge again')
    assert.equal(glass.fadeLayers, 4, 'the phone header lost its progressive blur layers')
    assert.notEqual(glass.fadeBlur, 'none', 'the phone header lost its glass blur')
    assert.match(glass.fadeMask, /linear-gradient/, 'the phone header blur no longer fades out')
    assert.ok(glass.fadeReach > 0, 'the phone header blur stops at its own edge')
    // Header and composer buttons are bare glyphs until pressed.
    assert.equal(glass.menuButton, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'the menu button shows its box at rest')
    assert.equal(glass.attachButton, 'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)', 'the attach button shows its box at rest')
    assert.notEqual(glass.composerBlur, 'none', 'the phone composer lost its glass blur')
    assert.match(glass.composerBackground, /rgba\(.+, 0\.58\)/)
    assert.ok(glass.bottomGap <= 5, `the phone composer sits ${glass.bottomGap}px above the bottom`)
    assert.notEqual(glass.modelMask, 'none', 'the clipped model text has no fade mask')
    assert.equal(glass.modelOverlay, 'none', 'a blur layer still sits over the model text')
    await screen.screenshot({ path: path.join(directory, 'phone-chat-verified.png') })
    await screen.click('#menuBtn')
    const menuGlass = await screen.$eval('#menuDrop .mcol', (el) => {
      const style = getComputedStyle(el)
      return { width: el.getBoundingClientRect().width, font: getComputedStyle(el.querySelector('.mrow')).fontSize, blur: style.backdropFilter }
    })
    assert.ok(menuGlass.width <= 220, `the phone menu is too wide: ${menuGlass.width}px`)
    assert.equal(menuGlass.font, '16px')
    assert.notEqual(menuGlass.blur, 'none', 'the phone menu lost its glass blur')
    await screen.screenshot({ path: path.join(directory, 'phone-menu-glass.png') })
    await screen.evaluate(() => closeMenu())
    log('phone chat fits narrow, wide, and landscape viewports')

    // Everything the desktop can do from its composer and Settings, the phone
    // can do too — and the desktop sees it done.
    // Revert: paused on the phone, the last exchange comes back out of the
    // history on both screens and the prompt goes back in the phone's box.
    await api('/api/prompt', { sessionId, prompt: 'slow revert me' })
    await screen.waitForFunction(() => currentRunId !== null, null, { timeout: 5000 })
    await screen.click('#sendBtn')
    await screen.waitForFunction(() => !document.getElementById('revertBtn').classList.contains('hidden') &&
      document.getElementById('sendBtn').getAttribute('aria-label') === 'Resume', null, { timeout: 10000 })
    await screen.click('#revertBtn')
    await screen.waitForFunction(() => document.getElementById('prompt').value === 'slow revert me', null, { timeout: 5000 })
    assert.equal(await screen.$eval('#transcript', (el) => el.textContent.includes('slow revert me')), false)
    assert.equal(await screen.$eval('#revertBtn', (el) => el.classList.contains('hidden')), true)
    assert.ok(!(await api('/api/session/' + sessionId)).messages.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === 'slow revert me')))
    await window.waitForFunction((id) => !window.__store.getState().sessions.find((s) => s.id === id).messages
      .some((m) => m.parts.some((p) => p.kind === 'text' && p.text === 'slow revert me')), sessionId, { timeout: 5000 })
    assert.equal(await window.evaluate((id) => window.__store.getState().pausedSessions[id] === true, sessionId), false)
    await screen.fill('#prompt', '')
    log('the phone reverts a paused turn, on both screens')

    // Model and approval mode stay in the composer; the long model fades out
    // early enough that a paused session still has room for Revert.
    assert.ok((await screen.evaluate(() => ['modelChip', 'modeChip', 'chipRow'].map((id) =>
      getComputedStyle(document.getElementById(id)).display))).every((display) => display !== 'none'))
    // Default or Auto, from the phone's Settings; the desktop chip follows.
    await screen.click('#menuBtn')
    await screen.click('#menuDrop .mrow:text-is("Settings")')
    await screen.waitForSelector('#settingsSheet:not(.hidden)')
    assert.equal(await screen.$eval('#policyDefault', (el) => el.classList.contains('on')), true)
    await screen.click('#policyAuto')
    await screen.waitForFunction(() => document.getElementById('policyAuto').classList.contains('on'), null, { timeout: 5000 })
    assert.equal((await window.evaluate(() => window.anticode.getStatus())).autoApprove, true)
    await window.getByRole('button', { name: 'Auto', exact: true }).waitFor()
    await screen.click('#policyDefault')
    await screen.waitForFunction(() => document.getElementById('policyDefault').classList.contains('on'), null, { timeout: 5000 })
    assert.equal((await window.evaluate(() => window.anticode.getStatus())).autoApprove, false)
    log('the phone switches Default and Auto, and the desktop follows')

    // Session usage, as the desktop's usage popover shows it.
    const usage = await screen.$eval('#usageGrid', (el) => el.textContent)
    assert.match(usage, /Input tokens[\d,]+Output tokens[\d,]+Total tokens[\d,]+Messages\d+/)
    log('the phone shows what the open session has used')

    // A provider added on the phone appears in the desktop's list; removed, it goes.
    await screen.fill('#provLabel', 'Phone Local')
    await screen.selectOption('#provKind', 'ollama')
    await screen.fill('#provURL', 'http://127.0.0.1:9/v1')
    await screen.click('#secProviders .actions button')
    await screen.waitForFunction(() => [...document.querySelectorAll('#providerList .nm')].some((el) => el.textContent === 'Phone Local'), null, { timeout: 5000 })
    assert.ok((await window.evaluate(() => window.anticode.listProviders())).some((p) => p.label === 'Phone Local'))
    await screen.evaluate(() => document.querySelector('#settingsSheet .sheet').scrollTo(0, 0))
    await screen.screenshot({ path: path.join(directory, 'phone-settings.png') })
    screen.once('dialog', (dialog) => void dialog.accept())
    await screen.click('#providerList .prow:has(.nm:text-is("Phone Local")) .px')
    await screen.waitForFunction(() => ![...document.querySelectorAll('#providerList .nm')].some((el) => el.textContent === 'Phone Local'), null, { timeout: 5000 })
    assert.ok(!(await window.evaluate(() => window.anticode.listProviders())).some((p) => p.label === 'Phone Local'))
    await screen.click('#settingsSheet .shead button')
    log('the phone adds and removes a provider, and the desktop list follows')

    // Searching sessions, as the desktop dashboard does.
    await screen.evaluate(() => gotoSessions())
    await screen.waitForSelector('#sessionList .row')
    const everyRow = await screen.$$eval('#sessionList .row', (els) => els.length)
    await screen.fill('#sessionSearch', 'workspace')
    const matched = await screen.$$eval('#sessionList .row .title', (els) => els.map((el) => el.textContent))
    assert.ok(matched.length >= 1 && matched.length < everyRow, `search did not narrow: ${matched.length} of ${everyRow}`)
    await screen.fill('#sessionSearch', 'no-such-session-anywhere')
    assert.equal(await screen.$$eval('#sessionList .row', (els) => els.length), 0)
    await screen.fill('#sessionSearch', '')
    log('the phone searches its sessions')

    assert.deepEqual(phoneErrors, [])
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
