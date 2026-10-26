// Isolated Electron: titles while space permits, icons only when truly full.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-tab-density-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__store))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 850))
  await page.evaluate(() => {
    const store = window.__store.getState()
    for (let i = 0; i < 12; i++) store.openSession('chat', null)
  })
  const strip = page.locator('[data-session-tabs]')
  const tabs = strip.locator('[data-tab-id]')
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-id]').length === 12)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-tab-id]')].every(tab => tab.querySelector('button[title]')))
  assert.equal(await tabs.count(), 12)
  assert.ok(await tabs.first().locator('button[title]').isVisible())
  await page.evaluate(() => {
    const store = window.__store.getState()
    for (let i = 0; i < 18; i++) store.openSession('chat', null)
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-id]').length === 30 && [...document.querySelectorAll('[data-tab-id]')].every(tab => tab.title))
  assert.equal(await tabs.first().locator('button[title]').count(), 0)
  const closedId = await tabs.first().getAttribute('data-tab-id')
  await tabs.first().hover()
  await tabs.first().getByRole('button', { name: 'Close tab', exact: true }).click()
  await page.waitForFunction(id => !document.querySelector(`[data-tab-id="${id}"]`), closedId)
  assert.equal(await tabs.count(), 29)
  await page.evaluate(() => {
    const store = window.__store.getState()
    for (const session of store.sessions.filter(item => !item.closed).slice(12)) store.closeSession(session.id)
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-id]').length === 12)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-tab-id]')].every(tab => tab.querySelector('button[title]')))
  assert.equal(await tabs.count(), 12)
  console.log('PASS: 12 tabs retain short titles; 30 switch to icons; closing tabs restores titles')
} finally { await app.close() }
