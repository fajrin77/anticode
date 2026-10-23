// Isolated Electron + real SDK/SSE transport. No user accounts or live providers.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-tool-markup-'))
const workspace = path.join(directory, 'workspace')
await mkdir(workspace)
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const calls = []
const counts = new Map()
const raw = '< | DSML | invoke name="write_file">< | DSML | parameter name="path" string="true">blocked-output.txt< | DSML | parameter name="content" string="true">MUST_NOT_APPEAR'
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'recover-fixture' }, { id: 'repeat-fixture' }] })); return }
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  calls.push(request)
  const count = (counts.get(request.model) ?? 0) + 1
  counts.set(request.model, count)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  if (request.model === 'repeat-fixture' || count === 1) {
    frame({ content: 'Inspecting the fixture. ' })
    for (const char of raw) frame({ content: char })
    frame({}, 'stop')
  } else if (count === 2) {
    assert.match(JSON.stringify(request.messages), /native structured tool-call/)
    frame({ tool_calls: [{ index: 0, id: 'native-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'native-output.txt', content: 'SAFE_NATIVE_TOOL' }) } }] }, 'tool_calls')
  } else {
    assert.ok(request.messages.some(message => message.role === 'tool' && message.tool_call_id === 'native-write'))
    frame({ content: 'Native tool completed.' }, 'stop')
  }
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
try {
  app = await electron.launch({ args: [bootstrap], env, cwd: directory })
  const page = await app.firstWindow()
  const provider = await page.evaluate(async baseURL => {
    const api = window.anticode
    const providers = await api.addProvider({ label: 'Markup fixture', kind: 'openai', apiKey: 'fixture', baseURL, models: ['recover-fixture', 'repeat-fixture'] })
    const id = providers.find(provider => provider.label === 'Markup fixture').id
    await api.setProviderVisibility(id, true)
    await api.setAutoApprove(false)
    return id
  }, `http://127.0.0.1:${server.address().port}/v1`)
  await page.evaluate(async ({ provider, workspace }) => {
    await window.anticode.createSession({ sessionId: 'markup', mode: 'code', workspaceRoot: workspace })
    await window.anticode.selectProvider({ provider, model: 'recover-fixture' }, 'markup')
  }, { provider, workspace })
  await page.locator('[data-tab-id="markup"] button[title]').first().click()
  const start = async model => page.evaluate(async ({ provider, model }) => {
    const api = window.anticode
    await api.selectProvider({ provider, model }, 'markup')
    const runId = crypto.randomUUID()
    window.markupEvents = []
    window.markupDone = new Promise(resolve => {
      const off = api.onAgentEvent(event => {
        if (event.runId !== runId) return
        window.markupEvents.push(event)
        if (event.type === 'end' || event.type === 'error') { off(); resolve(event) }
      })
    })
    await api.sendPrompt({ sessionId: 'markup', runId, prompt: 'Write the fixture result with native tools.', attachmentIds: [] })
  }, { provider, model })
  await start('recover-fixture')
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor()
  await assert.rejects(access(path.join(workspace, 'native-output.txt')))
  await assert.rejects(access(path.join(workspace, 'blocked-output.txt')))
  assert.doesNotMatch(await page.locator('body').innerText(), /DSML|MUST_NOT_APPEAR|blocked-output/)
  console.log('PASS: split raw DSML stays out of chat; recovery still requires normal tool approval')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  const recovered = await page.evaluate(() => window.markupDone)
  assert.equal(recovered.reason, 'complete')
  assert.equal(await readFile(path.join(workspace, 'native-output.txt'), 'utf8'), 'SAFE_NATIVE_TOOL')
  assert.equal(counts.get('recover-fixture'), 3)
  const events = await page.evaluate(() => window.markupEvents)
  assert.equal(events.filter(event => event.type === 'tool_end').length, 1)
  assert.doesNotMatch(JSON.stringify(events), /DSML|MUST_NOT_APPEAR|blocked-output/)
  await page.getByText('Native tool completed.', { exact: true }).waitFor()
  console.log('PASS: one correction produces a native tool call, one write, its tool result, and a final answer')
  await start('repeat-fixture')
  const failed = await page.evaluate(() => window.markupDone)
  assert.equal(failed.type, 'error')
  assert.match(failed.message, /format tool yang tidak valid/)
  assert.equal(counts.get('repeat-fixture'), 2)
  const snapshot = await page.evaluate(() => window.anticode.getSessionSnapshot('markup'))
  assert.doesNotMatch(JSON.stringify(snapshot), /MUST_NOT_APPEAR|blocked-output|< \| DSML/)
  assert.doesNotMatch(await page.locator('body').innerText(), /MUST_NOT_APPEAR|blocked-output|< \| DSML/)
  await assert.rejects(access(path.join(workspace, 'blocked-output.txt')))
  await page.screenshot({ path: path.join(directory, 'markup-handled.png') })
  console.log('PASS: repeated malformed output stops after one correction, with no raw command execution or transcript leak')
  console.log(JSON.stringify({ directory, requests: calls.length, evidence: 'fixture' }))
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
