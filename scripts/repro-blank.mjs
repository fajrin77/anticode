#!/usr/bin/env node
// Repro harness for the reported desktop blank screen. Launches a SECOND,
// fully isolated instance of the PACKAGED app (the /Applications copy) with a
// cloned user profile, listens for renderer errors and inspects the DOM after
// the idle window in which the user sees the flash to blank. The running app
// and the real profile are never touched: HOME is redirected, so every state
// path (Library/Application Support/anticode) lands in the clone instead.
// Usage: node scripts/repro-blank.mjs [--appid /Applications/anticode.app] [--profile <dir>] [--idle 30]
import { _electron as electron } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const appPath = arg('appid', '/Applications/anticode.app')
const idleSeconds = Number(arg('idle', '30'))
// The app's user data resolves to $HOME/Library/Application Support/anticode,
// so redirect HOME to a throwaway tree and clone only small state files into
// that location. The real profile is never opened by the second instance.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anticode-repro-home-'))
const userData = path.join(home, 'Library', 'Application Support', 'anticode')
fs.mkdirSync(userData, { recursive: true })
const realUserData = path.join(os.homedir(), 'Library', 'Application Support', 'anticode')
for (const name of [
  'Local Storage',
  'Session Storage',
  'Cookies',
  'Cookies-journal',
  'Preferences',
  'Local State',
  'sessions.json',
  'settings.json',
  'preferences.json',
  'secrets.json',
  'usage.json',
]) {
  const source = path.join(realUserData, name)
  if (fs.existsSync(source)) fs.cpSync(source, path.join(userData, name), { recursive: true })
}

const executable = path.join(appPath, 'Contents', 'MacOS', 'anticode')
const resources = path.join(appPath, 'Contents', 'Resources')
const asarPath = ['app.asar', 'app'].map((name) => path.join(resources, name)).find((candidate) => fs.existsSync(candidate))
if (!fs.existsSync(executable) || asarPath === undefined) {
  console.error(`No app at ${appPath}`)
  process.exit(1)
}
console.log(`[harness] packaged code: ${asarPath}`)

const errors = []

const app = await electron.launch({
  args: [asarPath],
  cwd: path.dirname(appPath),
  env: {
    ...process.env,
    HOME: home,
    ANTICODE_REMOTE_PORT: '18899',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
})
app.process().stdout?.on('data', (chunk) => console.log(`[main-out] ${String(chunk).trimEnd()}`))
app.process().stderr?.on('data', (chunk) => console.log(`[main-err] ${String(chunk).trimEnd()}`))
const window = (await app.windows().catch(() => []))[0] ?? (await app.firstWindow())
window.on('pageerror', (error) => {
  const line = `[pageerror] ${error.message}\n${error.stack ?? ''}`
  errors.push(line)
  console.log(line)
})
window.on('console', (message) => {
  if (message.type() === 'error') {
    const line = `[console.error] ${message.text()}`
    errors.push(line)
    console.log(line.slice(0, 400))
  }
})
window.on('crash', () => {
  const line = '[window] renderer crashed'
  errors.push(line)
  console.log(line)
})
app.process().on('exit', (code) => {
  console.log(`[main] exited with code ${code}`)
})

console.log(`[harness] launching second instance: ${asarPath} via stock Electron`)
console.log(`[harness] fake HOME: ${home} (user data cloned from ${realUserData})`)
console.log('[harness] window up; idling to reach the reported blank phase...')
await window.waitForLoadState('load')
await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1000))

const snapshot = await window.evaluate(() => ({
  href: window.location.href,
  root: document.getElementById('root') !== null,
  rootChildren: document.getElementById('root') !== null ? document.getElementById('root').childElementCount : -1,
  rootHtmlLength: document.getElementById('root') !== null ? document.getElementById('root').innerHTML.length : -1,
  bodyText: document.body.innerText.slice(0, 160),
})).catch((error) => ({ evaluateError: String(error) }))
console.log('[harness] snapshot after idle:', JSON.stringify(snapshot, null, 2))
if (snapshot.rootChildren === 0 || snapshot.rootHtmlLength < 50) console.log('[harness] BLANK STATE REPRODUCED')

if (errors.length > 0) {
  console.log('\n===== captured renderer errors =====')
  const seen = new Set()
  for (const error of errors) {
    const key = error.split('\n')[0]
    if (seen.has(key)) continue
    seen.add(key)
    console.log(error)
  }
} else {
  console.log('\n[harness] no renderer errors captured')
}

await app.close()
process.exit(0)
