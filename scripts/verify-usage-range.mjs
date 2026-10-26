// Real Electron IPC + renderer over isolated usage records; no provider calls.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-usage-range-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
const today = new Date(); today.setHours(12, 0, 0, 0)
// Keep the oldest row safely inside the 90-day retention window at any hour.
const rows = [0, 2, 12, 40, 80].map((days, index) => {
  const date = new Date(today); date.setDate(date.getDate() - days)
  return { ts: date.getTime(), sessionId: 'fixture', runId: String(index), provider: 'fixture', providerLabel: 'Fixture', model: `range-model-${index}`, inputTokens: 100 * (index + 1), cachedTokens: 10, outputTokens: 20, costUsd: 0, estimated: false, subagent: false }
})
// Keep today's record in the past even when run before noon.
rows[0].ts = Date.now() - 1
await writeFile(path.join(directory, 'usage.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(directory)}); app.whenReady().then(()=>import(${JSON.stringify(path.resolve('out/main/index.js'))}));`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env })
try {
  const page = await app.firstWindow()
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Usage', exact: true }).click()
  const breakdown = page.locator('[data-day-breakdown]')
  for (const [range, count] of [['Today', 1], ['7D', 2], ['30D', 3], ['60D', 4], ['All', 5]]) {
    await page.getByRole('button', { name: range, exact: true }).click()
    await breakdown.getByText(`Total ${range} · ${count} requests`, { exact: true }).waitFor()
    assert.equal(await breakdown.locator('[data-usage-column="input"]').count(), count)
    const text = await breakdown.innerText()
    for (let index = 0; index < count; index++) assert.ok(text.includes(`range-model-${index}`))
    const chart = page.locator('[aria-label="Tokens per day"]')
    await chart.getByRole('button').first().click()
    await breakdown.getByRole('button', { name: 'Show range total' }).waitFor()
    assert.equal(await breakdown.locator('[data-usage-column="input"]').count(), 1)
    // Switching ranges must clear the day drilldown, even if the date exists.
    await page.getByRole('button', { name: '24h', exact: true }).click()
    await breakdown.getByText('Total 24h · 1 requests', { exact: true }).waitFor()
  }
  console.log('PASS: Today/7D/30D/60D/All aggregate every model in the range; day drilldown resets on range change')
} finally { await app.close() }
