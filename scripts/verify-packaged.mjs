// Smoke test the PACKAGED app with an empty profile. Isolated user-data-dir,
// no account credentials, no provider calls.
import { _electron as electron } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const binary = process.argv[2] ?? 'release/mac-arm64/anticode.app/Contents/MacOS/anticode'
const profile = await mkdtemp(path.join(tmpdir(), 'anticode-packaged-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: binary,
  args: [`--user-data-dir=${profile}`],
  env
})
const errors = []
app.process().stderr.on('data', (d) => { const s = String(d); if (/Error|Unhandled/i.test(s)) errors.push('MAIN: ' + s.trim()) })
const window = await app.firstWindow()
window.on('pageerror', (e) => errors.push('RENDERER: ' + e.message))
try {
  await window.waitForLoadState('domcontentloaded')
  const title = await window.title()
  await window.getByRole('button', { name: 'antichat', exact: true }).waitFor({ timeout: 20000 })
  console.log('PASS: packaged app boots with an empty profile (title:', title + ')')
  await window.getByRole('button', { name: 'antichat', exact: true }).click()
  await window.getByPlaceholder(/just vibes/).waitFor({ timeout: 10000 })
  console.log('PASS: new chat session opens and the composer is reachable')
  await window.getByRole('button', { name: 'Settings', exact: true }).click()
  await window.getByRole('button', { name: 'Remote', exact: true }).waitFor({ timeout: 10000 })
  console.log('PASS: Settings and the Remote pane render')
  await new Promise((r) => setTimeout(r, 1500))
  assert.deepEqual(errors, [])
  console.log('PASS: no startup errors on a first run')
  console.log(JSON.stringify({ profile, binary }))
} catch (error) {
  console.error('UI at failure:', await window.locator('body').innerText().catch(() => '(unavailable)'))
  console.error('Collected errors:', errors)
  await window.screenshot({ path: path.join(profile, 'failure.png') }).catch(() => {})
  console.error('Screenshot:', path.join(profile, 'failure.png'))
  throw error
} finally {
  await app.close()
}
