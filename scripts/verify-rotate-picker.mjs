// Electron UI + real SDK transport against a local fixture. No live accounts.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-rotate-picker-'))
const requests = []
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: ['manual-fixture', 'rotate-a', 'rotate-b'].map(id => ({ id })) }))
    return
  }
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw)
  requests.push(body)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  frame({ content: `Reply from ${body.model}.` })
  frame({}, 'stop')
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'CLINEPASS_API_KEY']) delete env[key]
let app
const launch = async () => {
  app = await electron.launch({ args: [bootstrap], env, cwd: directory })
  return app.firstWindow()
}
try {
  let page = await launch()
  const setup = await page.evaluate(async baseURL => {
    const api = window.anticode
    const providers = await api.addProvider({ kind: 'openai', label: 'Rotation fixture', baseURL, apiKey: 'fixture', models: ['manual-fixture', 'rotate-a', 'rotate-b'] })
    const provider = providers.find(item => item.label === 'Rotation fixture').id
    await api.setProviderVisibility(provider, true)
    await api.setRotation(['manual-fixture', 'rotate-a', 'rotate-b'].map(model => ({ provider, model })))
    await api.setRotationGroups([{ name: 'Deepseek fixture', entries: ['rotate-a', 'rotate-b'].map(model => ({ provider, model })) }])
    const status = await api.setRotationEnabled(true)
    const group = status.rotationGroups[0].id
    await api.selectRotationGroup(group)
    await api.createSession({ sessionId: 'picker', title: 'Picker regression', mode: 'chat', workspaceRoot: null })
    await api.createSession({ sessionId: 'other', title: 'Unchanged session', mode: 'chat', workspaceRoot: null })
    await api.selectProvider({ provider, model: 'manual-fixture' }, 'picker')
    await api.selectProvider({ provider, model: 'manual-fixture' }, 'other')
    return { provider, group }
  }, `http://127.0.0.1:${server.address().port}/v1`)
  await page.locator('[data-session-tabs] > div').first().locator('button[title]').first().click()
  const openManualPicker = async () => {
    await page.locator('[data-composer-box]').getByRole('button', { name: 'manual-fixture', exact: true }).click()
    await page.locator('[data-picker-provider="rotate"]').click()
  }
  await openManualPicker()
  // This is the original failure: no extra "Use Rotate" click is allowed.
  await page.waitForFunction(async () => (await window.anticode.getStatus()).sessions.picker.provider === 'rotate', undefined, { timeout: 5000 })
  assert.equal(await page.getByRole('button', { name: 'Using Rotate usage', exact: true }).count(), 1)
  assert.equal(await page.evaluate(async () => (await window.anticode.getStatus()).sessions.other.model), 'manual-fixture')
  await page.screenshot({ path: path.join(directory, 'rotate-selected.png') })
  console.log('PASS: one Rotate tab click changes the current session; another pinned session stays intact')
  // A selected group must work without toggling it away and back.
  await page.locator('[data-picker-group="Deepseek fixture"]').click()
  await page.keyboard.press('Escape')
  const send = async prompt => {
    const composer = page.getByPlaceholder(/just vibes|what to change|Add to the task|Queue the next/)
    await composer.fill(prompt)
    await composer.press('Enter')
    await page.waitForFunction(async () => !(await window.anticode.listRuns()).some(run => run.sessionId === 'picker'))
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  }
  await send('Respond briefly: first rotation request')
  assert.ok(['rotate-a', 'rotate-b'].includes(requests.at(-1)?.model))
  assert.equal(requests.some(request => request.model === 'manual-fixture'), false)
  assert.equal(await page.evaluate(async () => (await window.anticode.getStatus()).rotationGroup), setup.group)
  console.log('PASS: the actual SDK request uses the selected rotation group, not the old manual model')
  // Ordinary provider tabs continue to browse until a model is chosen.
  await page.locator('[data-composer-box]').getByRole('button', { name: /^rotate/ }).click()
  await page.locator(`[data-picker-provider="${setup.provider}"]`).click()
  assert.equal(await page.evaluate(async () => (await window.anticode.getStatus()).sessions.picker.provider), 'rotate')
  await page.locator('[data-picker-model="manual-fixture"]').click()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).sessions.picker.model === 'manual-fixture')
  await openManualPicker()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).sessions.picker.provider === 'rotate')
  await page.locator('[data-picker-group="All models"]').click()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).rotationGroup === null)
  await page.locator('[data-picker-group="Deepseek fixture"]').click()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).rotationGroup !== null)
  await page.keyboard.press('Escape')
  console.log('PASS: manual → Rotate can be repeated, provider browsing stays safe, and group switching applies')
  await app.close()
  page = await launch()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).sessions.picker?.provider === 'rotate')
  await page.locator('[data-session-tabs] > div').first().locator('button[title]').first().click()
  await send('Respond briefly: rotation after restart')
  assert.ok(['rotate-a', 'rotate-b'].includes(requests.at(-1)?.model))
  console.log('PASS: rotation choice survives restart and routes the next prompt correctly')
  await page.evaluate(async provider => {
    await window.anticode.setRotationGroups([])
    await window.anticode.selectProvider({ provider, model: 'manual-fixture' }, 'picker')
  }, setup.provider)
  await openManualPicker()
  await page.waitForFunction(async () => (await window.anticode.getStatus()).sessions.picker.provider === 'rotate')
  assert.equal(await page.locator('[data-picker-group]').count(), 0)
  await page.keyboard.press('Escape')
  console.log('PASS: one-click Rotate also works with no saved groups')
  await page.evaluate(() => window.anticode.setRotationEnabled(false))
  await page.locator('[data-composer-box]').getByRole('button', { name: 'manual-fixture', exact: true }).click()
  assert.equal(await page.locator('[data-picker-provider="rotate"]').count(), 0)
  console.log('PASS: disabled rotation is unavailable in the picker')
  console.log(JSON.stringify({ directory, models: requests.map(request => request.model) }))
} catch (error) {
  const page = app?.windows()[0]
  if (page) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {})
    console.error(await page.locator('body').innerText())
  }
  throw error
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
