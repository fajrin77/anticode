// Fixture only: checks generic provider migration and top-layer dashboard menus.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-clean-settings-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: {} }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(directory)});
process.env.CLINEPASS_API_KEY = 'fixture-legacy-key';
process.env.CLINEPASS_BASE_URL = 'https://api.cline.bot/api/v1';
global.fetch = async input => {
  if (String(input).includes('/models')) return Response.json({ data: [] });
  throw new Error('Unexpected fixture network request');
};
app.whenReady().then(() => import(${JSON.stringify(path.resolve('out/main/index.js'))}));
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1100, height: 720 })
  const legacy = await page.evaluate(async () => (await window.anticode.listProviders()).find(p => p.id === 'clinepass'))
  assert.equal(legacy.kind, 'auth')
  assert.equal(legacy.authKind, 'clinepass')
  assert.equal(legacy.billing, 'subscription')
  const saved = await readFile(path.join(directory, 'providers.json'), 'utf8')
  assert.ok(!saved.includes('fixture-legacy-key'))
  assert.equal(JSON.parse(saved).providers.length, 0)
  assert.ok(!(await readFile(path.join(directory, 'auth-accounts.json'), 'utf8')).includes('fixture-legacy-key'))
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  assert.equal(await page.getByText('Run without approval prompts, including high-risk actions', { exact: true }).count(), 0)
  await page.screenshot({ path: path.join(directory, 'general-clean.png') })
  await page.getByRole('button', { name: 'Providers', exact: true }).click()
  assert.equal(await page.getByText('built-in', { exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Restore Clinepass', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Auth provider', exact: true }).click()
  assert.equal(await page.getByPlaceholder('Plan key', { exact: true }).count(), 0)
  assert.equal(await page.getByText('Clinepass', { exact: true }).count(), 0)
  await page.evaluate(async () => {
    const api = window.anticode
    const entries = []
    for (let index = 0; index < 12; index++) {
      const label = `Fixture service ${index}`
      const providers = await api.addProvider({ label, kind: 'openai', baseURL: 'https://fixture.test/v1', apiKey: 'fixture-key', models: [`fixture-model-${index}`] })
      const provider = providers.find(p => p.label === label)
      entries.push({ provider: provider.id, model: `fixture-model-${index}` })
      await api.setProviderVisibility(provider.id, true)
    }
    await api.setRotation(entries)
    await api.selectProvider(entries[0])
  })
  await page.getByRole('button', { name: /Back/ }).click()
  await page.getByRole('button', { name: 'fixture-model-0', exact: true }).click()
  const menu = page.locator('[data-model-picker]')
  await menu.waitFor()
  assert.equal(await menu.evaluate(el => el.matches(':popover-open')), true)
  const geometry = await menu.evaluate(el => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, right: el.getBoundingClientRect().right, header: document.querySelector('header').getBoundingClientRect().bottom, height: window.innerHeight, width: window.innerWidth }))
  assert.ok(geometry.top >= geometry.header + 4)
  assert.ok(geometry.bottom <= geometry.height)
  assert.ok(geometry.right <= geometry.width)
  await page.screenshot({ path: path.join(directory, 'dashboard-picker.png') })
  await menu.locator('[data-picker-provider]').last().click()
  await menu.getByRole('button', { name: 'fixture-model-11', exact: true }).click()
  await menu.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'fixture-model-11', exact: true }).waitFor()
  await page.setViewportSize({ width: 940, height: 600 })
  await page.getByRole('button', { name: 'fixture-model-11', exact: true }).click()
  assert.ok(await menu.evaluate(el => el.getBoundingClientRect().top >= document.querySelector('header').getBoundingClientRect().bottom))
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  console.log(JSON.stringify({ status: 'passed', evidence: 'fixture', directory, checks: ['legacy key sealed and migrated to Auth ClinePass', 'no built-in/restore/Plan key UI', 'concise settings', 'top-layer picker below header', 'provider tabs scroll and model selection works', 'small window and Escape'] }))
} finally { await app.close() }
