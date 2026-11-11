// Starts a PACKAGED anticode and attaches to its window over the Chrome
// DevTools Protocol. Playwright's electron.launch needs the Node inspector,
// which the release build turns off (EnableNodeCliInspectArguments fuse);
// --remote-debugging-port is a Chromium switch the fuses leave alone, and it
// reaches every renderer, which is all these tests drive.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

export async function launchPackaged({ binary, args = [], env = process.env, timeoutMs = 30_000 }) {
  const port = await freePort()
  const child = spawn(binary, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = null
  child.once('exit', (code, signal) => { exited = { code, signal } })
  const deadline = Date.now() + timeoutMs
  let browser = null
  while (browser === null) {
    if (exited !== null) throw new Error(`The packaged app exited before it could be attached to: ${JSON.stringify(exited)}`)
    if (Date.now() > deadline) { child.kill(); throw new Error('The packaged app never opened its debugging port') }
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2_000 })
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const firstWindow = async () => {
    for (;;) {
      const page = browser.contexts().flatMap((context) => context.pages()).find((entry) => !entry.url().startsWith('devtools://'))
      if (page !== undefined) return page
      if (Date.now() > deadline) throw new Error('The packaged app opened no window')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const close = async () => {
    await browser.close().catch(() => undefined)
    if (exited === null) {
      child.kill('SIGTERM')
      await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 5_000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
    }
  }
  return { child, browser, firstWindow, close }
}
