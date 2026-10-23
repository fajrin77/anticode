// Isolated Electron + real SDK transport. Fixtures only, no live account usage.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import sharp from 'sharp'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-session-recovery-'))
const profile = path.join(directory, 'profile')
await mkdir(profile)
await writeFile(path.join(profile, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const image = path.join(directory, 'fixture.png')
await sharp({ create: { width: 32, height: 32, channels: 3, background: '#d1fa22' } }).png().toFile(image)
const requests = []
let interruptions = 0
let toolRound = 0
const server = createServer(async (request, response) => {
  if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [] })); return }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish = null) => response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n')
  if (body.model === 'vision-fixture' && toolRound < 2) {
    toolRound++
    frame({ content: 'Memeriksa direktori fixture.', tool_calls: [{ index: 0, id: 'check-' + toolRound, type: 'function', function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) } }] }, 'tool_calls')
    response.end('data: [DONE]\n\n')
    return
  }
  if (interruptions > 0) {
    interruptions--
    frame({ content: '## Pekerjaan berjalan\n\nBagian yang sudah diterima.' })
    setTimeout(() => response.destroy(), 150)
    return
  }
  frame({ content: '## Hasil\n\nPekerjaan fixture selesai.\n\n## Pemeriksaan\n\n- Respons diterima.' })
  frame({}, 'stop')
  response.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(profile)}); app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: [bootstrap], env, cwd: directory })
  let page = await app.firstWindow()
  const provider = await page.evaluate(async baseURL => {
    const api = window.anticode
    const list = await api.addProvider({ kind: 'openai', label: 'Recovery fixture', baseURL, apiKey: 'fixture', models: ['vision-fixture', 'deepseek-v4.1-flash:free', 'moonshotai/kimi-k3:batch'] })
    const id = list.find(item => item.label === 'Recovery fixture').id
    await api.createSession({ sessionId: 'recovery', title: 'Recovery fixture', mode: 'chat', workspaceRoot: null })
    return id
  }, baseURL)
  const send = (model, prompt, attachmentPaths = []) => page.evaluate(async ({ provider, model, prompt, attachmentPaths }) => {
    const api = window.anticode
    await api.selectProvider({ provider, model }, 'recovery')
    const attachments = attachmentPaths.length ? await api.addAttachments(attachmentPaths) : []
    const runId = crypto.randomUUID()
    const events = []
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(Error('Fixture timeout')) }, 90000)
      const off = api.onAgentEvent(event => {
        if (event.runId !== runId) return
        events.push(event)
        if (event.type === 'end' || event.type === 'error') { clearTimeout(timer); off(); resolve(events) }
      })
    })
    await api.sendPrompt({ sessionId: 'recovery', runId, prompt, attachmentIds: attachments.map(item => item.id) })
    return done
  }, { provider, model, prompt, attachmentPaths })
  await send('vision-fixture', 'Jelaskan gambar fixture.', [image])
  assert.ok(JSON.stringify(requests.at(-1)).includes('image_url'))
  const text = await send('deepseek-v4.1-flash:free', 'Lanjutkan pekerjaan teks.')
  assert.equal(text.at(-1).reason, 'complete')
  assert.ok(text.some(event => event.type === 'notice' && event.text.includes('Gambar')))
  assert.ok(!JSON.stringify(requests.at(-1)).includes('image_url'))
  await send('vision-fixture', 'Periksa gambar lama kembali.')
  assert.ok(JSON.stringify(requests.at(-1)).includes('image_url'))
  const before = requests.length
  const refused = await send('deepseek-v4.1-flash:free', 'Baca gambar baru.', [image])
  assert.equal(refused.at(-1).type, 'error')
  assert.equal(requests.length, before)
  interruptions = 1
  const recovered = await send('deepseek-v4.1-flash:free', 'Pulihkan gangguan sementara.')
  assert.equal(recovered.at(-1).reason, 'complete')
  assert.ok(recovered.some(event => event.type === 'notice' && event.text.includes('Melanjutkan')))
  assert.equal(requests.length, before + 2)
  interruptions = 6
  const cut = await send('deepseek-v4.1-flash:free', 'Kerjakan pertanyaan teks berikutnya.')
  assert.equal(cut.at(-1).retryable, true)
  assert.equal(cut.at(-1).summary.outcome, 'error')
  assert.equal(requests.length, before + 8)
  const snapshot = await page.evaluate(() => window.anticode.getSessionSnapshot('recovery'))
  assert.ok(JSON.stringify(snapshot.messages).includes('Bagian yang sudah diterima.'))
  assert.ok(JSON.stringify(snapshot.messages).includes('fixture.png'))
  await page.locator('[data-session-tabs] button[title]').first().click()
  await page.getByText('Terhenti karena kesalahan', { exact: true }).first().waitFor()
  await page.locator('[data-interrupted-report]').waitFor()
  await page.screenshot({ path: path.join(directory, 'interrupted.png') })
  await app.close()
  app = await electron.launch({ args: [bootstrap], env, cwd: directory })
  const restarted = await app.firstWindow()
  page = restarted
  const restored = await restarted.evaluate(() => window.anticode.getSessionSnapshot('recovery'))
  assert.equal(restored.summaries.at(-1).outcome, 'error')
  assert.ok(JSON.stringify(restored.messages).includes('Bagian yang sudah diterima.'))
  const continued = await send('deepseek-v4.1-flash:free', 'lanjut')
  assert.equal(continued.at(-1).reason, 'complete')
  assert.ok(!JSON.stringify(requests.at(-1)).includes('image_url'))
  console.log('PASS: old image replay, new image refusal, vision restoration, automatic partial stream recovery, retry exhaustion, durable interrupted outcome')
  console.log(JSON.stringify({ directory, requests: requests.length }))
} finally {
  await app?.close()
  await new Promise(resolve => server.close(resolve))
}
