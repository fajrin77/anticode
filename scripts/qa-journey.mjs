// QA journey — berperan sebagai pengguna nyata anticode (desktop).
// Pola launcher sama dengan verify-ui.mjs (profil sementara + stub provider SSE),
// tetapi perjalanannya baru: prompt, antrean, pause, steer/resume, popover usage,
// mode anticode tanpa folder, tab baru/tutup, hapus sesi.
// Ekspektasi diselaraskan dengan perilaku asli (lihat Composer.tsx):
//  - pause = tombol di toolbar run; "Paused." adalah baris transkrip permanen
//  - Enter saat paused = resume + pesan bergabung ke balasan (bukan tombol Continue terpisah)
//  - meter konteks = popover Session usage (TabBar), bukan transkrip
//  - anticode tanpa folder = draft tetap, tidak membuat sesi (shake + Choose folder menyala)
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-qa-'))
const profile = path.join(directory, 'profile'); await mkdir(profile)
const workspace = path.join(directory, 'workspace'); await mkdir(workspace)
await writeFile(path.join(workspace, 'hello.txt'), 'isi awal')
const shots = path.join(directory, 'shots'); await mkdir(shots)
console.log('SHOTS_DIR=' + shots)
const failures = []
const check = (name, ok, detail = '') => {
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (detail ? ' -> ' + detail : ''))
  if (!ok) failures.push(name + (detail ? ' (' + detail + ')' : ''))
}
const wait = (ms) => window.waitForTimeout(ms)
const STUB_DELAY = Number(process.env.STUB_DELAY || 3500)

const stub = createServer(async (req, res) => {
  let raw = ''; for await (const p of req) raw += p
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model', object: 'model' }] }))
    return
  }
  const body = raw ? JSON.parse(raw) : {}
  const uc = Array.isArray(body.messages) ? body.messages.filter(m => m.role === 'user') : []
  const last = uc.at(-1)
  const pill = (p) => typeof p === 'string' ? p : (p && p.type === 'text' ? p.text : '[' + (p && p.type) + ']')
  const text = last ? (Array.isArray(last.content) ? last.content.map(pill).join(' ') : String(last.content)) : ''
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunk = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 't', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n')
  chunk({ content: 'Fixture reply. ' })
  await new Promise(r => setTimeout(r, STUB_DELAY))
  if (res.destroyed) return
  chunk({ content: 'Pesan terakhir pengguna: ' + text.slice(0, 90) })
  chunk({}, 'stop')
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }) + '\n\n')
  res.end('data: [DONE]\n\n')
})
await new Promise(r => stub.listen(0, '127.0.0.1', r))

const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ rotation: { entries: [{ provider: 'clinepass', model: 'test-model' }], usage: {} } }))
await writeFile(bootstrap, "const { app } = require('electron'); app.setPath('userData', " + JSON.stringify(profile) + "); import(" + JSON.stringify(path.resolve('out/main/index.js')) + ");")
const env = { ...process.env, CLINEPASS_API_KEY: 'fixture-key', CLINEPASS_BASE_URL: 'http://127.0.0.1:' + stub.address().port + '/v1', CLINEPASS_MODEL: 'test-model' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [bootstrap], env })
const window = await app.firstWindow()
await window.setViewportSize({ width: 1280, height: 820 })
window.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)))
const shot = async (n) => { await window.screenshot({ path: path.join(shots, n + '.png') }); console.log('shot:', n) }
const composer = () => window.getByPlaceholder(/just vibes|what to change|Add to the task/)
const pauseBtn = () => window.locator('button[aria-label="Pause"]')
const queueChips = () => window.locator('[data-queue] > div')
const usageBtn = () => window.locator('button[title="Session usage"]')

try {
  // J1 — pengguna membuka app: dasbor antichat
  await window.getByRole('button', { name: 'antichat', exact: true }).first().waitFor({ timeout: 30000 })
  await shot('01-dashboard')

  // J2 — pilih mode antichat dulu (dasbor default-nya anticode/code), lalu prompt pertama
  await window.getByRole('button', { name: 'antichat', exact: true }).first().click()
  await wait(400)
  await composer().fill('halo lambat, journey pertama saya')
  await composer().press('Enter')
  await window.getByText(/Fixture reply/).first().waitFor({ timeout: 25000 })
  await shot('02-session-first-reply')
  check('J2 prompt pertama: sesi terbentuk, balasan mengalir', true)

  // J3 — antrean saat run + popover usage.
  // Resep ala pengguna: fokus klik cukup SEKALI sebelum run; di tengah streaming
  // ketik murni lewat window.keyboard — locator action menunggu layout stabil
  // dan hanya berhasil setelah run selesai (bukan cara orang mengetik).
  const queueToggle = window.locator('button[title*="queue"]')
  check('J3 toggle steer/queue tersedia saat run berjalan', (await queueToggle.count()) >= 1)
  if (await queueToggle.count()) {
    await queueToggle.first().click()
    await wait(250)
    await window.keyboard.type('antrian lewat queue')
    await window.keyboard.press('Enter')
    await wait(500)
    check('J3 mode queue: chip "queued 1" tampil saat run streaming', (await queueChips().count()) === 1,
      'chips=' + (await queueChips().count()))
    const chipText = (await queueChips().innerText().catch(() => ''))
    check('J3 mode queue: teks antrian tampil di chip', chipText.includes('antrian lewat queue'), chipText.slice(0, 60))
  }
  await shot('03-queue-chips')
  // kembali ke steer untuk sisa journey
  if (await queueToggle.count()) await queueToggle.first().click()
  // tunggu semua antrean kering (2 giliran @ ~3.5s)
  let steady = false
  for (let i = 0; i < 14; i++) {
    await wait(1000)
    if ((await queueChips().count()) === 0 && (await pauseBtn().count()) === 0) { steady = true; break }
  }
  check('J3 antrean habis: run kembali diam, tidak ada giliran nyangkut', steady)
  // popover Session usage = meter konteks
  await usageBtn().first().click()
  await wait(400)
  const usagePanel = await window.getByText('Session usage').count()
  const ctxBar = await window.locator('div.menu-glass div.h-full').count()
  check('J3 meter konteks: popover Session usage berisi angka token + bar', usagePanel >= 1 && ctxBar >= 1,
    'panel=' + usagePanel + ' bar=' + ctxBar)
  await shot('04-usage-popover')
  await window.keyboard.press('Escape')
  await wait(250)

  // J4 — pause di tengah giliran
  await composer().fill('prompt untuk dipause')
  await composer().press('Enter')
  await wait(1200)
  if (await pauseBtn().count()) {
    await pauseBtn().first().click()
    await window.getByText('Paused.').first().waitFor({ timeout: 9000 })
    await shot('05-paused')
    check('J4 pause: baris "Paused." muncul dan streaming berhenti', true)
  } else {
    check('J4 tombol Pause tersedia saat giliran berjalan', false, 'tombol tidak ditemukan')
  }

  // J5 — steer: menulis + Enter saat paused = resume dan pesan bergabung
  await composer().fill('instruksi tambahan sebelum resume')
  await composer().press('Enter')
  await wait(1500)
  const joined = (await window.getByText(/Joined/).count()) >= 1 ||
    (await window.getByText('instruksi tambahan sebelum resume').count()) >= 1
  const backToPauseBtn = (await pauseBtn().count()) >= 1
  await shot('06-after-steer-resume')
  check('J5 steer saat pause: pesan bergabung dan run me-resume', joined && backToPauseBtn,
    'joined=' + joined + ' resume=' + backToPauseBtn)
  let settled = false
  for (let i = 0; i < 12; i++) {
    await wait(1000)
    if ((await pauseBtn().count()) === 0) { settled = true; break }
  }
  check('J5 setelah steer: giliran selesai dan composer k正常运行 ke keadaan Send', settled)

  // J6 — mode anticode tanpa folder: draft tetap, tidak bikin sesi
  await window.getByRole('button', { name: 'Dashboard', exact: true }).first().click()
  await wait(500)
  await window.getByRole('button', { name: 'anticode', exact: true }).first().click()
  await wait(300)
  await composer().fill('tantangan anticode tanpa folder')
  await composer().press('Enter')
  await wait(900)
  await shot('07-anticode-no-folder')
  const composerStill = await composer().isVisible()
  const stillDraft = ((await composer().inputValue()) || '').includes('tantangan anticode')
  check('J6 anticode tanpa folder: tetap di dasbor, draft utuh (hint folder menyala)', composerStill && stillDraft,
    'composer=' + composerStill + ' draft=' + stillDraft)
  const glowFolder = await window.getByRole('button', { name: /Choose a project folder|Choose folder/ }).count()
  console.log('[info] tombol folder tersedia:', glowFolder)

  // J7 — tab baru lalu tutup tab
  await window.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await wait(700)
  await shot('08-new-tab')
  const closeTab = window.getByRole('button', { name: 'Close tab' })
  check('J7 tab baru: ada tab kedua dengan tombol Close tab', (await closeTab.count()) >= 1)
  if ((await closeTab.count()) >= 1) {
    await closeTab.first().click()
    await wait(700)
    await shot('09-after-close-tab')
    check('J7 tutup tab: app tetap hidup dan UI siap dipakai', await usageBtn().first().isVisible().catch(() => false))
  }

  // J8 — hapus sesi yang tersisa
  const delBtn = window.getByRole('button', { name: 'Delete session' })
  if (await delBtn.count()) {
    await delBtn.first().click()
    await wait(800)
    await shot('10-after-delete')
    check('J8 hapus sesi: kembali ke dasbor tanpa crash',
      await window.getByRole('button', { name: 'antichat', exact: true }).first().isVisible().catch(() => false))
  } else {
    console.log('[info] tombol Delete session tidak ada saat ini (mungkin butuh popover sesi)')
  }
} catch (err) {
  check('J0 journey berjalan tanpa error', false, String(err && err.message ? err.message.split('\n')[0] : err))
  try { console.log('PAGE:\n' + (await window.locator('body').innerText()).slice(0, 1200)) } catch {}
  await shot('99-crash')
} finally {
  console.log('SUMMARY_FAIL=' + failures.length)
  if (failures.length) console.log('FAILURES:\n- ' + failures.join('\n- '))
  await app.close()
  stub.close()
  process.exit(failures.length ? 1 : 0)
}
