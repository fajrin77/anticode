// Isolated UI fixture: no prompts or real provider calls.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-sidebar-'))
const profile = path.join(directory, 'profile')
await mkdir(profile)
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [bootstrap], env, cwd: directory })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForFunction(() => Boolean(window.__store))
  await page.waitForTimeout(1000)
  const ids = await page.evaluate(() => {
    const store = window.__store.getState()
    const first = store.openSession('code', '/tmp/sidebar-project')
    const second = store.openSession('code', '/tmp/sidebar-project')
    window.__store.setState((state) => ({ sessions: state.sessions.map((session) => ({ ...session, title: session.id === first ? 'First session' : 'Second session' })) }))
    return { first, second }
  })
  const sidebar = page.getByRole('complementary', { name: 'Daftar sesi' })
  await sidebar.locator(`[data-session-id="${ids.first}"]`).click()
  assert.equal(await page.evaluate(() => window.__store.getState().activeSessionId), ids.first)
  assert.equal(await page.locator('header [data-session-id]').count(), 0)
  await sidebar.getByRole('button', { name: 'Sesi baru di sidebar-project', exact: true }).click()
  const fresh = await page.evaluate(() => {
    const state = window.__store.getState()
    return state.sessions.find((session) => session.id === state.activeSessionId)
  })
  assert.equal(fresh.projectRoot, '/tmp/sidebar-project')
  assert.equal(fresh.messages.length, 0)
  assert.notEqual(fresh.id, ids.first)
  const before = await page.evaluate(() => window.__store.getState().sessions.length)
  await sidebar.getByRole('button', { name: '+ New Season', exact: true }).click()
  await page.getByRole('button', { name: 'antichat', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__store.getState().sessions.length), before)
  const group = sidebar.getByRole('button', { name: 'sidebar-project', exact: true })
  await group.click()
  assert.equal(await sidebar.locator(`[data-session-id="${ids.first}"]`).count(), 0)
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  assert.equal(await sidebar.count(), 0)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
  await sidebar.waitFor()
  assert.equal(await group.getAttribute('aria-expanded'), 'false', 'collapsed project stays collapsed after sidebar hide/show')
  assert.equal(await sidebar.locator(`[data-session-id="${ids.first}"]`).count(), 0)
  await group.click()
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  assert.equal(await group.getAttribute('aria-expanded'), 'true', 'manually expanded project stays expanded')
  await sidebar.locator(`[data-session-id="${ids.first}"]`).click()
  await page.screenshot({ path: path.join(directory, 'sidebar.png') })
  await page.setViewportSize({ width: 800, height: 650 })
  async function checkLayout() {
    const bounds = await page.evaluate(() => {
      const main = document.querySelector('main').getBoundingClientRect()
      const composer = document.querySelector('[data-composer], textarea')
      const box = composer.getBoundingClientRect()
      const elements = [...document.querySelectorAll('main textarea, main button, main [data-transcript], main svg[role="img"]')]
      return {
        width: box.width,
        mainWidth: main.width,
        clipped: elements.filter((el) => {
          if (!el.getClientRects().length) return false
          const panel = el.closest('[data-web-panel]')
          if (panel && panel.getBoundingClientRect().width < 2) return false
          const rect = el.getBoundingClientRect()
          return rect.left < main.left - 1 || rect.right > main.right + 1
        }).map((el) => el.getAttribute('title') || el.tagName)
      }
    })
    assert.deepEqual(bounds.clipped, [], 'main content must fit within the session column')
    return bounds
  }
  for (const width of [800, 1100]) {
    await page.setViewportSize({ width, height: 820 })
    const shown = await checkLayout()
    await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
    const hidden = await checkLayout()
    assert.ok(hidden.mainWidth > shown.mainWidth)
    assert.ok(hidden.width > shown.width, 'composer expands when sidebar hides')
    await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  }
  // Cover the floating composer and transcript as well as the fresh-session hero.
  await page.evaluate(() => {
    const store = window.__store.getState()
    store.addMessage({ id: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'Layout fixture' }], pending: false })
  })
  await page.locator('[data-transcript]').waitFor()
  await page.setViewportSize({ width: 800, height: 820 })
  await checkLayout()
  await page.screenshot({ path: path.join(directory, 'session-narrow.png') })
  await page.evaluate(async (sessionId) => {
    await window.anticode.createSession({ sessionId, mode: 'code', workspaceRoot: null })
    localStorage.setItem('anticode-web-width', '1000')
    await window.anticode.setWebVisible(sessionId, true)
  }, ids.first)
  await page.locator('[data-web-panel]').waitFor()
  await page.waitForTimeout(250)
  async function checkSplit() {
    const sizes = await page.evaluate(() => {
      const main = document.querySelector('main').getBoundingClientRect()
      const session = document.querySelector('[data-session-slide]').getBoundingClientRect()
      const browser = document.querySelector('[data-web-panel]').getBoundingClientRect()
      const composer = document.querySelector('[data-composer-box]').getBoundingClientRect()
      const controls = [...document.querySelectorAll('[data-web-panel] header button, [data-web-panel] header input, [data-composer-box] button')]
      return { main: main.width, session: session.width, browser: browser.width,
        fits: composer.left >= session.left && composer.right <= session.right,
        controlsFit: controls.every(el => {
          const r = el.getBoundingClientRect()
          const area = el.closest('[data-web-panel]') ? browser : session
          return r.left >= area.left - 1 && r.right <= area.right + 1
        }) }
    })
    assert.ok(sizes.session >= sizes.main / 2 - 1, 'browser reserves at least half the available column for session')
    assert.ok(sizes.browser > 0 && sizes.browser <= sizes.main / 2 + 1)
    assert.ok(sizes.fits && sizes.controlsFit, 'composer and browser controls fit their own panes')
    return sizes
  }
  const splitOpen = await checkSplit()
  await page.screenshot({ path: path.join(directory, 'browser-sidebar.png') })
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  const splitHidden = await checkSplit()
  assert.ok(splitHidden.session > splitOpen.session)
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  await page.locator('[data-web-panel]').getByRole('button', { name: 'Hide browser', exact: true }).click()
  await page.waitForTimeout(250)
  await checkLayout()

  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  await checkLayout()
  await page.getByRole('button', { name: '+ New Season', exact: true }).first().click()
  await page.getByRole('button', { name: 'antichat', exact: true }).waitFor()
  await checkLayout()
  await page.getByRole('button', { name: 'Buka/tutup sidebar', exact: true }).click()
  await checkLayout()
  // Session actions use a top-layer popover, so the scrolling sidebar cannot clip it.
  await page.evaluate(async (id) => {
    await window.anticode.createSession({ sessionId: id, mode: 'code', workspaceRoot: null })
  }, ids.second)
  const options = sidebar.getByRole('button', { name: 'Opsi sesi Second session', exact: true })
  await options.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Arsipkan', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: 'Arsipkan', exact: true }).isVisible(), false)
  await options.click()
  await page.getByRole('button', { name: 'Arsipkan', exact: true }).click()
  assert.equal(await sidebar.locator(`[data-session-id="${ids.second}"]`).count(), 0)
  assert.equal(await page.evaluate(id => window.__store.getState().sessions.find(s => s.id === id).closed, ids.second), true)
  await sidebar.getByRole('button', { name: 'Tampilkan arsip', exact: true }).click()
  await sidebar.locator(`[data-session-id="${ids.second}"]`).click()
  await options.click()
  await page.getByRole('button', { name: 'Hapus', exact: true }).click()
  assert.equal(await sidebar.locator(`[data-session-id="${ids.second}"]`).count(), 1, 'first delete click only asks for confirmation')
  await page.keyboard.press('Escape')
  await options.click()
  assert.equal(await page.getByRole('button', { name: 'Hapus', exact: true }).isVisible(), true)
  await page.getByRole('button', { name: 'Hapus', exact: true }).click()
  await page.getByRole('button', { name: 'Konfirmasi hapus permanen', exact: true }).click()
  await page.waitForFunction(id => !window.__store.getState().sessions.some(s => s.id === id), ids.second)
  const scroll = await sidebar.locator('nav').evaluate(el => {
    el.style.height = '70px'
    el.style.flex = 'none'
    el.scrollTop = 40
    return { hidden: getComputedStyle(el).scrollbarWidth, scrollable: el.scrollTop > 0 }
  })
  assert.equal(scroll.hidden, 'none')
  assert.equal(scroll.scrollable, true)
  console.log(`PASS: project grouping, selection, same-project draft, dashboard, collapse, shortcut, narrow layout. Screenshot: ${directory}/sidebar.png`)
} finally {
  await app.close()
}
