// Isolated renderer fixtures: latest completed/interrupted turns and history.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-changed-files-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const env = { ...process.env, ANTICODE_USER_DATA: directory, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [path.resolve('out/main/index.js')], env })
try {
  const page = await app.firstWindow()
  await page.route('**/assets/*.js', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('Object.assign(window,{', 'Object.assign(window,{__store:Ve,') })
  })
  await page.goto('file://' + path.resolve('out/renderer/index.html') + '#recover')
  await page.waitForFunction(() => Boolean(window.__store) && window.location.hash === '')
  const setFixture = async (state, extra = false) => page.evaluate(({ state, extra }) => {
    const store = window.__store
    const id = store.getState().activeSessionId ?? store.getState().openSession('code', '/fixture')
    const assistant = {
      id: 'answer', role: 'assistant', pending: state === 'running',
      parts: [
        { kind: 'tool', toolUseId: 'write1', name: 'write_file', input: { path: 'fixture.ts' }, output: 'Written (+3)', status: 'ok', diff: '' },
        { kind: 'text', text: 'Fixture report' }
      ],
      ...(state !== 'running' ? { summary: { model: 'fixture', durationMs: 1000, inputTokens: 10, outputTokens: 10, outcome: state === 'error' ? 'error' : 'complete' } } : {})
    }
    const messages = [{ id: 'prompt', role: 'user', pending: false, parts: [{ kind: 'text', text: 'Edit fixture' }] }, assistant]
    if (extra) messages.push({ id: 'next', role: 'user', pending: false, parts: [{ kind: 'text', text: 'Next question' }] }, { id: 'next-answer', role: 'assistant', pending: false, parts: [{ kind: 'text', text: 'No edits' }] })
    store.setState(s => ({ sessions: s.sessions.map(session => session.id === id ? { ...session, messages, busy: state === 'running' } : session) }))
  }, { state, extra })
  await setFixture('running')
  assert.equal(await page.locator('[data-changed-files]').count(), 0)
  for (const outcome of ['complete', 'error']) {
    await setFixture(outcome)
    await page.locator('[data-changed-files]').waitFor()
    assert.equal(await page.locator('[data-changed-files]').count(), 1)
    assert.match(await page.locator('[data-changed-files]').innerText(), /fixture\.ts/)
    assert.match(await page.locator('[data-changed-files]').innerText(), /\+3/)
  }
  await setFixture('complete', true)
  assert.equal(await page.locator('[data-changed-files]').count(), 1)
  await page.evaluate(() => {
    const store = window.__store
    window.__fixtureSession = store.getState().activeSessionId
    store.getState().openSession('code', '/other')
  })
  await page.evaluate(() => window.__store.setState({ activeSessionId: window.__fixtureSession }))
  await page.locator('[data-changed-files]').waitFor()
  assert.equal(await page.locator('[data-changed-files]').count(), 1)
  console.log('PASS: changed files visible on completion and error, absent while running, retained in history and after tab switching')
} finally { await app.close() }
