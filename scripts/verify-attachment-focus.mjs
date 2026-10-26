// Isolated Electron UI test; attachment focus needs no provider or file upload.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-attachment-focus-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env })
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__store))
  for (const draft of ['__dashboard__', 'session']) {
    if (draft === 'session') {
      await page.evaluate(() => {
        const store = window.__store.getState()
        store.openSession('chat', null)
      })
    }
    await page.locator('textarea').first().waitFor()
    await page.locator('textarea').first().fill('')
    await page.evaluate(draft => {
      const store = window.__store.getState()
      const id = draft === '__dashboard__' ? draft : store.activeSessionId
      document.activeElement?.blur()
      store.updateDraft(id, { attachments: [{ id: 'focus-fixture', kind: 'image', name: 'focus.png', path: '/fixture/focus.png', size: 10, mediaType: 'image/png' }] })
    }, draft)
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    await page.keyboard.type('langsung ketik')
    assert.equal(await page.locator('textarea').first().inputValue(), 'langsung ketik')
  }
  console.log('PASS: new attachment focuses textarea and accepts typing on dashboard and session')
} finally { await app.close() }
