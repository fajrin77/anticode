// Isolated Electron: titles through nine tabs, icons from ten on.
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
  // Recovery mode skips the asynchronous startup prune of fixture-only tabs.
  await page.evaluate(() => { window.location.hash = 'recover' })
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__store) && window.location.hash === '')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 850))
  await page.evaluate(() => {
    const store = window.__store.getState()
    for (let i = 0; i < 9; i++) store.openSession('code', `/fixture/project-${i}`)
  })
  const tabs = page.locator('[data-session-tabs] [data-tab-id]')
  const assertNewTabVisible = async () => {
    const plus = page.getByRole('button', { name: 'New tab', exact: true })
    assert.equal(await plus.count(), 1)
    assert.equal(await plus.evaluate(el => el.closest('[data-session-tabs]') === null), true)
    await plus.click({ trial: true })
    const box = await plus.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= await page.evaluate(() => window.innerWidth))
  }
  const titled = (count) => page.waitForFunction(expected => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')]
    return tabs.length === expected && tabs.every(tab => tab.querySelector('button[title]'))
  }, count)
  await titled(9)
  assert.equal(await tabs.count(), 9)
  assert.ok(await tabs.first().locator('button[title]').isVisible())
  // The title takes real horizontal room, not a one-pixel sliver.
  const titleWidth = await tabs.first().locator('button[title]').evaluate(el => el.getBoundingClientRect().width)
  assert.ok(titleWidth >= 40, `title width ${titleWidth}`)
  await assertNewTabVisible()
  await page.evaluate(() => window.__store.getState().openSession('chat', null))
  await page.waitForFunction(() => {
    const tabs = [...document.querySelectorAll('[data-tab-id]')]
    return tabs.length === 10 && tabs.every(tab => tab.title && tab.querySelector('button[title]') === null)
  })
  assert.equal(await tabs.first().locator('button[title]').count(), 0)
  assert.equal(await tabs.last().locator('button[title]').count(), 0)
  await assertNewTabVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
  await assertNewTabVisible()
  await page.locator('[data-session-tabs]').evaluate(el => { el.scrollLeft = el.scrollWidth })
  await assertNewTabVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 850))
  const closedId = await tabs.first().getAttribute('data-tab-id')
  await tabs.first().hover()
  await tabs.first().getByRole('button', { name: 'Close tab', exact: true }).click()
  await page.waitForFunction(id => !document.querySelector(`[data-tab-id="${id}"]`), closedId)
  await titled(9)
  assert.equal(await tabs.count(), 9)
  console.log(`PASS: 9 tabs keep titles (${Math.round(titleWidth)}px wide); 10 turn every tab into an icon; closing one restores titles`)
  for (const width of [900, 1400]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width)
    const last = tabs.last()
    await last.hover()
    const close = last.getByRole('button', { name: 'Close tab', exact: true })
    await close.click({ trial: true })
    assert.ok(await close.evaluate(el => {
      const button = el.getBoundingClientRect()
      const strip = el.closest('[data-session-tabs]').getBoundingClientRect()
      return button.left >= strip.left && button.right <= strip.right + 1
    }), `last close is clipped at width ${width}`)
    const plus = await page.getByRole('button', { name: 'New tab', exact: true }).boundingBox()
    const lastBox = await last.boundingBox()
    assert.ok(plus && lastBox && plus.x >= lastBox.x + lastBox.width - 1, 'plus must sit to the right of the final tab without overlapping')
  }
  await tabs.last().getByRole('button', { name: 'Close tab', exact: true }).click()
  await titled(8)
  console.log('PASS: final tab close remains clickable at narrow/wide widths; actual close removes the final tab')
} finally { await app.close() }
