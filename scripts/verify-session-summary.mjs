// Run after npm run build. A temporary profile and a local OpenAI-compatible
// stub; no account credentials, no paid calls. Checks what a reader of a long,
// multi-model session sees: a finished reply folds its working notes, a
// rotation hand-over is said out loud, a compacted session shows its summary
// card, and the new controls follow the lime hover rule.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const LIME = 'rgb(209, 250, 34)'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-summary-'))
const profile = path.join(directory, 'profile'); await mkdir(profile)
/** The model that took the hand-over prompt's first step; it is refused after that. */
let limitedModel = null

const stub = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'test-model-2' }] })); return }
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw)
  const system = body.messages.find((m) => m.role === 'system')?.content ?? ''
  const systemText = typeof system === 'string' ? system : system.map((p) => p.text ?? '').join('')
  const lastUser = body.messages.filter((m) => m.role === 'user').at(-1)?.content
  const text = typeof lastUser === 'string' ? lastUser : lastUser?.filter((p) => p.type === 'text').map((p) => p.text).join(' ') ?? ''
  const afterUser = body.messages.slice(body.messages.findLastIndex((m) => m.role === 'user') + 1)
  const toolTurns = afterUser.filter((m) => m.role === 'tool').length
  if (text.includes('handover-fixture') && toolTurns > 0 && limitedModel === body.model) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
    res.end(JSON.stringify({ error: { message: 'Fixture rate limit' } }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 't', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  if (systemText.startsWith('You compact')) {
    chunk({ content: 'MEMORY: the user asked for folded notes and a hand-over check.' }); chunk({}, 'stop')
  } else if (text.includes('handover-fixture') && toolTurns === 0) {
    limitedModel = body.model
    chunk({ tool_calls: [{ index: 0, id: 'ls-handover', type: 'function', function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) } }] })
    chunk({}, 'tool_calls')
  } else if (text.includes('notes-fixture') && toolTurns < 2) {
    chunk({ content: toolTurns === 0 ? 'Working note one.' : 'Working note two.' })
    chunk({ tool_calls: [{ index: 0, id: `ls-${toolTurns}`, type: 'function', function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) } }] })
    chunk({}, 'tool_calls')
  } else {
    chunk({ content: text.includes('notes-fixture') ? 'FINAL ANSWER for notes.' : `Fixture reply: ${text.slice(0, 60)}` }); chunk({}, 'stop')
  }
  res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))

await writeFile(path.join(profile, 'settings.json'), JSON.stringify({
  composerProviders: { clinepass: true },
  rotation: { enabled: true, entries: [{ provider: 'clinepass', model: 'test-model' }, { provider: 'clinepass', model: 'test-model-2' }], usage: {} }
}))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, CLINEPASS_API_KEY: 'fixture-key', CLINEPASS_BASE_URL: `http://127.0.0.1:${stub.address().port}/v1`, CLINEPASS_MODEL: 'test-model', ANTICODE_REMOTE_PORT: '18683' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
const window = await app.firstWindow()
const errors = []
window.on('pageerror', (error) => errors.push(error.message))
const log = (text) => console.log('PASS:', text)
const composer = () => window.getByPlaceholder(/just vibes/)
const colourOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color)
async function limeOnHover(name, locator) {
  let colour = ''
  for (let attempt = 0; attempt < 8 && colour !== LIME; attempt++) {
    await locator.hover(); await window.waitForTimeout(200); colour = await colourOf(locator)
  }
  assert.equal(colour, LIME, `${name} should turn lime on hover`)
  log(`${name} turns lime on hover`)
}

try {
  await window.getByRole('button', { name: 'antichat', exact: true }).click()
  await composer().fill('notes-fixture'); await composer().press('Enter')
  await window.getByText('FINAL ANSWER for notes.', { exact: true }).waitFor()
  // Settled, the reply reads as its answer: the notes fold behind one line.
  const folded = window.locator('[data-folded-notes]')
  await folded.waitFor()
  assert.match(await folded.innerText(), /2 working notes · show/)
  assert.equal(await window.getByText('Working note one.', { exact: true }).count(), 0)
  await limeOnHover('folded notes line', folded)
  await folded.click()
  await window.getByText('Working note one.', { exact: true }).waitFor()
  log('a finished reply folds its working notes and shows them on request')

  // The first request is rate limited; rotation hands the turn over and says so.
  await composer().fill('handover-fixture'); await composer().press('Enter')
  await window.getByText(/Fixture reply: handover-fixture/).waitFor()
  const notice = window.getByText(/^Switched from test-model(-2)? to test-model(-2)?: it was rate limited\.$/)
  await notice.waitFor()
  const footer = await window.locator('span', { hasText: /test-model(-2)? → test-model(-2)?/ }).count()
  assert.ok(footer > 0, 'the run footer names both models that served it')
  log('a rotation hand-over is said in the transcript and the footer names both models')

  // Manual compaction leaves a folded session-summary card on the desktop.
  await window.getByTitle('Session usage').click()
  await window.getByRole('button', { name: /Compact context/ }).click()
  await window.getByRole('button', { name: /Compact context \d[\d,]* → \d[\d,]* tokens/ }).waitFor()
  await window.keyboard.press('Escape')
  const card = window.locator('[data-session-summary] button').first()
  await card.waitFor()
  await limeOnHover('session summary card', card.locator('span').first())
  await card.click()
  await window.getByText(/MEMORY: the user asked for folded notes/).waitFor()
  log('a compacted session shows its summary card, folded until opened')

  // The phone draws the same card and folds the same notes.
  const remote = await window.evaluate(() => window.anticode.setRemoteEnabled(true))
  const sessionId = await window.evaluate(() => window.__store.getState().activeSessionId)
  {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`http://127.0.0.1:18683/?token=${remote.token}`)
    await page.waitForFunction(() => typeof openSession === 'function')
    await page.evaluate((id) => openSession(id), sessionId)
    await page.locator('#transcript .sumcard').first().waitFor()
    await page.locator('#transcript .notes-toggle').first().waitFor()
    assert.equal(await page.locator('#transcript .msg.folded .note').first().isVisible(), false)
    await page.locator('#transcript .notes-toggle').first().click()
    await page.getByText('Working note one.', { exact: true }).waitFor()
    await browser.close()
    log('the phone folds working notes and shows the session summary card')
  }

  // Settings → Providers: prompts per model, same border on and off, lime on hover.
  await window.getByTitle('Settings', { exact: true }).click()
  await window.getByRole('button', { name: 'Providers', exact: true }).click()
  const row = window.locator('[data-rotation-cadence]')
  await row.waitFor()
  const two = row.getByRole('button', { name: '2', exact: true })
  const one = row.getByRole('button', { name: '1', exact: true })
  assert.equal(await two.getAttribute('aria-pressed'), 'true')
  const before = await one.boundingBox()
  await limeOnHover('prompts-per-model choice', one)
  await one.click()
  await window.waitForFunction(() => window.anticode.getStatus().then((s) => s.promptsPerModel === 1))
  // The status broadcast redraws Settings; the pick shows as soon as it lands.
  await window.waitForFunction(() => document.querySelector('[data-rotation-cadence] button[aria-pressed="true"]')?.textContent === '1')
  assert.equal(await two.getAttribute('aria-pressed'), 'false')
  const after = await one.boundingBox()
  assert.deepEqual([after.x, after.y, after.width, after.height], [before.x, before.y, before.width, before.height], 'choosing a cadence must not move the control')
  log('prompts per model is set from Settings without moving the row')

  assert.deepEqual(errors, [])
  log('no renderer errors')
} finally {
  await app.close()
  stub.close()
}
