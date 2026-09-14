// Debug F2-userstyle: fokus sekali SEBELUM run, lalu ketik+Enter di TENGAH
// streaming murni lewat window.keyboard (tanpa click/fill → tanpa actionability-wait).
// Harapan bila app sehat: trace "queuePrompt running= true" + "enqueue", chips muncul,
// hanya SATU stub hit sampai run #1 selesai.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-q6-'))
const profile = path.join(directory, 'profile'); await mkdir(profile)
let stubHits = 0
const stub = createServer(async (req, res) => {
  let raw = ''; for await (const p of req) raw += p
  if ((req.url || '').includes('/models')) { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({object:'list',data:[{id:'test-model',object:'model'}]})); return }
  stubHits++
  console.log('[stub] run dimulai #' + stubHits)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const w = (d, f=null) => res.write('data: ' + JSON.stringify({id:'t',choices:[{index:0,delta:d,finish_reason:f}]}) + '\n\n')
  w({content:'Fixture reply. '})
  const beat = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 500)
  await new Promise(r => setTimeout(r, 15000))
  clearInterval(beat)
  if (!res.destroyed) {
    w({}, 'stop')
    res.write('data: ' + JSON.stringify({choices:[],usage:{prompt_tokens:5,completion_tokens:5}}) + '\n\n')
    res.end('data: [DONE]\n\n')
  }
  console.log('[stub] run selesai #' + stubHits)
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))

const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({rotation:{entries:[{provider:'clinepass',model:'test-model'}],usage:{}}}))
await writeFile(bootstrap, "const { app } = require('electron'); app.setPath('userData', " + JSON.stringify(profile) + "); import(" + JSON.stringify(path.resolve('out/main/index.js')) + ");")
const env = { ...process.env, CLINEPASS_API_KEY: 'fixture-key', CLINEPASS_BASE_URL: 'http://127.0.0.1:' + stub.address().port + '/v1', CLINEPASS_MODEL: 'test-model' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [bootstrap], env })
app.process().stdout?.on('data', d => process.stdout.write('[main] ' + d))
const window = await app.firstWindow()
await window.setViewportSize({ width: 1280, height: 820 })
const wait = (ms) => window.waitForTimeout(ms)
const composer = () => window.getByPlaceholder(/just vibes|what to change|Add to the task/)

await window.getByRole('button', { name: 'antichat', exact: true }).first().waitFor({ timeout: 30000 })
await window.getByRole('button', { name: 'antichat', exact: true }).first().click()
await wait(300)
// fokus dan ketik run pertama SEBELUM apa pun bergerak
await composer().click()
await window.keyboard.type('run utama panjang')
await window.keyboard.press('Enter')
await wait(2000) // run #1 streaming sekarang
// toggle mode queue: klik koordinat (bukan locator actionability)
const box = await window.locator('button[title*="queue"]').first().boundingBox().catch(() => null)
console.log('[step] toggle box:', JSON.stringify(box))
if (box) { await window.mouse.click(box.x + 10, box.y + 10); await wait(300) }
// ketik di tengah streaming — TANPA click, keyboard sudah fokus di textarea
await window.keyboard.type('antrian satu')
await window.keyboard.press('Enter')
await wait(1000)
const chips = await window.locator('[data-queue] > div').count().catch(() => -1)
const bodyHasIt = (await window.locator('body').innerText().catch(() => '')).includes('antrian satu')
console.log('[hasil] chips=' + chips, 'draftTerkirim=' + bodyHasIt)
console.log('[stub] hit saat ini (harus 1):', stubHits)
// biarkan drain bekerja: chip harus terkirim setelah run #1 selesai
await wait(13000)
console.log('[stub] hit akhir (masih harus 1+drain):', stubHits)
console.log('[hasil] chips setelah drain:', await window.locator('[data-queue] > div').count().catch(() => -1))
await app.close(); stub.close()
process.exit(0)
