// Isolated Electron/IPC/UI fixture. No real logins, quota endpoints, or inference.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-subscription-usage-'))
await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ remote: { enabled: false }, updates: { autoCheck: false } }))
await writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [], builtin: { clinepass: { removed: true } } }))
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `
const { app, safeStorage } = require('electron');
const { writeFileSync } = require('node:fs');
app.setPath('userData', ${JSON.stringify(directory)});
const realNow = Date.now.bind(Date); global.quotaClockOffset = 0; Date.now = () => realNow() + global.quotaClockOffset;
global.quotaCalls = 0; global.quotaFail = false;
global.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('/api/oauth/') || url.endsWith('/wham/usage')) {
    global.quotaCalls++;
    if (global.quotaFail) return new Response('{}', { status: 429 });
    if (url.endsWith('/profile')) return Response.json({ account: { has_claude_pro: true }, organization: { subscription_status: 'active' } });
    if (url.endsWith('/usage') && !url.endsWith('/wham/usage')) {
      const token = new Headers(init.headers).get('authorization');
      return Response.json({ five_hour: { utilization: token.endsWith('1') ? null : 17, resets_at: new Date(Date.now() + 209 * 60000).toISOString() }, seven_day: { utilization: 35, resets_at: '2026-10-27T16:00:00Z' }, extra_usage: { is_enabled: false } });
    }
    return Response.json({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: Date.now() / 1000 + 7200 }, secondary_window: { used_percent: 81, limit_window_seconds: 604800, reset_at: Date.now() / 1000 + 172800 } } });
  }
  throw new Error('Unexpected fixture request: ' + url);
};
app.whenReady().then(async () => {
  const accounts = ['claude', 'claude', 'codex', 'cline'].map((kind, index) => ({
    account: { id: 'auth:' + kind + '-' + index, kind, label: kind, account: index === 0 ? 'alpha@example.test' : 'account-' + index + '@example.test', createdAt: Date.now(), refreshable: false },
    sealed: 'safe:v1:' + safeStorage.encryptString(JSON.stringify({ accessToken: 'fixture-' + index, expiresAt: Date.now() + 7200000 })).toString('base64')
  }));
  writeFileSync(${JSON.stringify(path.join(directory, 'auth-accounts.json'))}, JSON.stringify({ version: 1, accounts }));
  await import(${JSON.stringify(path.resolve('out/main/index.js'))});
});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: [bootstrap], env })
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1160, height: 1050 })
  await page.getByTitle('Settings', { exact: true }).click()
  await page.getByRole('button', { name: 'Usage', exact: true }).click()
  const panel = page.locator('[data-subscription-usage]')
  await panel.locator('[data-quota-group="claude"] summary').click()
  const first = panel.locator('[data-quota-account="auth:claude-0"]')
  await first.getByRole('progressbar', { name: /Batas sesi/ }).waitFor()
  assert.equal(await first.getByRole('progressbar', { name: /Batas sesi/ }).getAttribute('aria-valuenow'), '17')
  assert.equal(await first.getByRole('progressbar', { name: /Mingguan/ }).getAttribute('aria-valuenow'), '35')
  await first.getByText(/Reset dalam 3 jam 29 menit/).waitFor()
  assert.equal(await panel.locator('[data-quota-account="auth:claude-1"]').getByRole('progressbar', { name: /Batas sesi/ }).getAttribute('aria-valuenow'), null)
  await page.screenshot({ path: path.join(directory, 'usage-quotas.png') })
  const calls = await app.evaluate(() => global.quotaCalls)
  await panel.getByRole('button', { name: 'Perbarui kuota subscription' }).click()
  await panel.getByRole('button', { name: 'Perbarui kuota subscription' }).waitFor({ state: 'visible' })
  assert.equal(await app.evaluate(() => global.quotaCalls), calls)
  await panel.locator('[data-quota-group="cline"] summary').click()
  await panel.getByText('Data batas paket dari layanan ini belum tersedia.').waitFor()
  await app.evaluate(() => { global.quotaFail = true; global.quotaClockOffset = 301000 })
  await panel.getByRole('button', { name: 'Perbarui kuota subscription' }).click()
  await first.getByText(/Menampilkan data terakhir/).waitFor()
  assert.equal(await first.getByRole('progressbar', { name: /Batas sesi/ }).getAttribute('aria-valuenow'), '17')
  await page.screenshot({ path: path.join(directory, 'usage-quotas-stale.png') })
  await page.setViewportSize({ width: 940, height: 800 })
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true)
  console.log(JSON.stringify({ status: 'passed', evidence: 'fixture', directory, checks: ['17% / 35% provider windows', 'reset countdown', 'unknown percentage is not zero', 'per-account grouping', 'request caching', 'unsupported provider', 'stale data preserved', 'narrow layout'] }))
} finally { await app.close() }
