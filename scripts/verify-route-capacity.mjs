// Real Electron + SDK transport; isolated profile, local fixture routes only.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-route-capacity-'))
const workspace = path.join(directory, 'workspace')
await mkdir(workspace)
await writeFile(path.join(workspace, 'facts.txt'), 'Important beginning.\n' + 'verified facts '.repeat(1600) + '\nImportant end.')
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const models = ['retired-fixture:free', 'healthy-fixture:free', 'small-fixture', 'compact-fixture']
const counts = new Map()
const requests = []
let compactLimit
const tokens = request => Math.ceil(JSON.stringify(request).length / 4)
const server = createServer(async (req, res) => {
  if (req.method === 'GET') { res.end(JSON.stringify({ data: models.map(id => ({ id })) })); return }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  const count = (counts.get(body.model) ?? 0) + 1
  counts.set(body.model, count)
  const error = (status, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: status, message }, user_id: 'private-fixture-account' })) }
  if (body.model === 'retired-fixture:free') { error(404, 'The :free variant has been retired; use paid/model instead ($1/M).'); return }
  if (body.model === 'small-fixture') { error(402, 'Prompt tokens limit exceeded: 13114 > 4064'); return }
  if (body.model === 'compact-fixture' && count === 2) {
    const emptyResults = { ...body, messages: body.messages.map(message => message.role === 'tool' ? { ...message, content: '' } : message) }
    compactLimit = tokens(emptyResults) + Math.floor((tokens(body) - tokens(emptyResults)) * 0.55)
    error(402, `Prompt tokens limit exceeded: ${tokens(body)} > ${compactLimit}`)
    return
  }
  if (body.model === 'compact-fixture' && count > 2 && tokens(body) > compactLimit) { error(402, `Prompt tokens limit exceeded: ${tokens(body)} > ${compactLimit}`); return }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  const call = (name, input) => frame({ tool_calls: [{ index: 0, id: 'native-' + name, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, 'tool_calls')
  if (body.model === 'healthy-fixture:free' && count === 1) call('write_file', { path: 'result.txt', content: 'VALIDATED_FREE_ROUTE' })
  else if (body.model === 'compact-fixture' && count === 1) call('read_file', { path: 'facts.txt' })
  else frame({ content: 'Fixture completed.' }, 'stop')
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let app
const launch = async () => { app = await electron.launch({ args: [bootstrap], env, cwd: directory }); return app.firstWindow() }
try {
  let page = await launch()
  const provider = await page.evaluate(async ({ baseURL, workspace, models }) => {
    const api = window.anticode
    const providers = await api.addProvider({ kind: 'openai', label: 'Capacity fixture', baseURL, apiKey: 'fixture', models })
    const provider = providers.find(item => item.label === 'Capacity fixture').id
    await api.setProviderVisibility(provider, true)
    await api.setRotation(['retired-fixture:free', 'healthy-fixture:free'].map(model => ({ provider, model })))
    await api.setRotationEnabled(true)
    await api.setAutoApprove(true)
    for (const sessionId of ['rotation', 'small', 'compact']) await api.createSession({ sessionId, mode: 'code', workspaceRoot: workspace })
    return provider
  }, { baseURL: `http://127.0.0.1:${server.address().port}/v1`, workspace, models })
  const send = async (sessionId, model, prompt = 'Finish the fixture task.') => page.evaluate(async ({ sessionId, model, provider, prompt }) => {
    const api = window.anticode
    if (model) await api.selectProvider({ provider, model }, sessionId)
    const runId = crypto.randomUUID()
    const events = []
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(Error('Fixture timed out')) }, 20000)
      const off = api.onAgentEvent(event => {
        if (event.runId !== runId) return
        events.push(event)
        if (event.type === 'end' || event.type === 'error') { clearTimeout(timer); off(); resolve(events) }
      })
    })
    await api.sendPrompt({ sessionId, runId, prompt, attachmentIds: [] })
    return done
  }, { sessionId, model, provider, prompt })
  const rotated = await send('rotation')
  assert.equal(rotated.at(-1).reason, 'complete')
  assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), 'VALIDATED_FREE_ROUTE')
  assert.equal(counts.get('retired-fixture:free'), 1)
  assert.equal(counts.get('healthy-fixture:free'), 2)
  assert.ok(requests.every(body => body.model.endsWith(':free')))
  assert.doesNotMatch(JSON.stringify(rotated), /private-fixture-account|paid\/model|user_id/)
  const routeStatus = await page.evaluate(() => window.anticode.getStatus())
  const denied = routeStatus.rotation.find(entry => entry.model === 'retired-fixture:free')
  assert.equal(denied.ready, false)
  assert.match(denied.unavailableReason, /dihentikan/)
  assert.equal(denied.outOfUsage, null)
  assert.equal(denied.coolingUntil, null)
  await send('rotation')
  assert.equal(counts.get('retired-fixture:free'), 1)
  console.log('PASS: explicit retirement moves Rotate to another selected free route; no paid request or account cooldown')
  const small = await send('small', 'small-fixture')
  assert.equal(small.at(-1).type, 'error')
  assert.match(small.at(-1).message, /larger request allowance/)
  await send('small', undefined, 'Lanjutkan pekerjaan.')
  assert.equal(counts.get('small-fixture'), 1)
  console.log('PASS: irreducible 13114/4064 request explains its limit; Continue does not resend it during the short evidence cache')
  const compacted = await send('compact', 'compact-fixture')
  assert.equal(compacted.at(-1).reason, 'complete')
  assert.equal(compacted.filter(event => event.type === 'tool_end').length, 1)
  assert.equal(counts.get('compact-fixture'), 3)
  assert.ok(compacted.some(event => event.type === 'notice' && event.text.includes('diringkas secara lokal')))
  console.log('PASS: a long tool-result turn is reduced once, fits the reported allowance, and completes without replaying the tool')
  await app.close()
  page = await launch()
  const restored = await page.evaluate(() => window.anticode.getStatus())
  assert.equal(restored.rotation.find(entry => entry.model === 'retired-fixture:free').ready, false)
  const advertised = await page.evaluate(provider => window.anticode.listModels(provider, true), provider)
  assert.ok(!advertised.models.includes('retired-fixture:free'), 'A stale catalogue must not revive a denied route')
  await page.locator('[data-tab-id="rotation"] button[title]').first().click()
  await page.locator('[data-composer-box]').getByRole('button', { name: /^rotate/ }).click()
  await page.getByText('unavailable', { exact: true }).waitFor()
  assert.doesNotMatch(await page.locator('body').innerText(), /private-fixture-account|paid\/model|user_id/)
  await page.screenshot({ path: path.join(directory, 'unavailable-route.png') })
  console.log('PASS: exact route denial survives restart and catalogue refresh; picker shows unavailable separately from quota/key errors')
  console.log(JSON.stringify({ directory, evidence: 'fixture', counts: Object.fromEntries(counts) }))
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
