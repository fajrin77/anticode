// Real Electron runtime + renderer + local fixture provider. No live accounts.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-agent-question-'))
const requests = []
const toolResult = (body) => JSON.stringify(body.messages ?? []).includes('call_question')
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'question-fixture' }] }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  if (!toolResult(body)) {
    frame({ tool_calls: [{ index: 0, id: 'call_question', type: 'function', function: { name: 'ask_question', arguments: JSON.stringify({ question: 'Pakai pendekatan yang mana?', options: [{ label: 'Cepat' }, { label: 'Aman' }] }) } }] })
    frame({}, 'tool_calls')
  } else {
    frame({ content: 'Jawaban diterima: saya lanjutkan.' })
    frame({}, 'stop')
  }
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseURL = `http://127.0.0.1:${server.address().port}/v1`
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'CLINEPASS_API_KEY']) delete env[key]
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__store))
  const setup = await page.evaluate(async baseURL => {
    const api = window.anticode
    const list = await api.addProvider({ kind: 'openai', label: 'Question fixture', baseURL, apiKey: 'fixture', models: ['question-fixture'] })
    const provider = list.find(item => item.label === 'Question fixture').id
    await api.setProviderVisibility(provider, true)
    await api.selectProvider({ provider, model: 'question-fixture' })
    const sessionId = window.__store.getState().openSession('chat', null)
    return { provider, sessionId }
  }, baseURL)
  await page.locator('textarea').first().fill('Kerjakan tugas dengan pertanyaan.')
  await page.keyboard.press('Enter')
  const modal = page.locator('[data-question]')
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Aman', exact: true }).click()
  await page.getByText('Jawaban diterima: saya lanjutkan.', { exact: true }).waitFor({ timeout: 20_000 })
  const history = await page.evaluate(async sessionId => {
    const snapshot = await window.anticode.getSessionSnapshot(sessionId, null)
    const store = window.__store.getState().sessions.find(item => item.id === sessionId)
    return { blocks: JSON.stringify(snapshot?.messages ?? []), rendered: JSON.stringify(store?.messages ?? []) }
  }, setup.sessionId)
  for (const text of ['Kerjakan tugas dengan pertanyaan.', 'Pakai pendekatan yang mana?', 'Aman', 'Jawaban diterima: saya lanjutkan.']) {
    assert.ok(history.blocks.includes(text.slice(0, 18)), `main transcript lost ${text}`)
    assert.ok(history.rendered.includes(text.slice(0, 18)), `renderer transcript lost ${text}`)
  }
  // A later turn must keep the earlier question and answer in view, not fold them away.
  await page.evaluate(async ({ sessionId, provider }) => {
    await window.anticode.sendPrompt({ sessionId, provider, model: 'question-fixture', prompt: 'Giliran berikutnya.', attachmentIds: [] })
  }, setup)
  await page.waitForFunction(() => !document.querySelector('[data-question]'), null, { timeout: 20_000 })
  await page.waitForTimeout(1500)
  const visible = await page.locator('body').innerText()
  assert.ok(visible.includes('Pakai pendekatan yang mana?'), 'visible transcript lost the question after the next turn')
  assert.ok(visible.includes('Aman'), 'visible transcript lost the answer after the next turn')
  assert.ok(requests.length >= 2)
  console.log('PASS: asked question keeps transcript in main and renderer, and stays visible after the next turn')
} finally {
  await app.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
