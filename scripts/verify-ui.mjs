// UI inspection harness: launches the app on a temp profile with a local stub
// provider and captures the states worth looking at. No real credentials, no
// paid API calls. Screenshots land in the directory printed at the end.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-ui-'))
const profile = path.join(directory, 'profile'); await mkdir(profile)
const workspace = path.join(directory, 'workspace'); await mkdir(workspace)
await writeFile(path.join(workspace, 'hello.txt'), 'original')
// A real image, for the attachment rendering check further down.
const picture = path.join(workspace, 'tangkapan.png')
await sharp({ create: { width: 320, height: 200, channels: 3, background: '#d1fa22' } })
  .png()
  .toFile(picture)
const shots = path.join(directory, 'shots'); await mkdir(shots)

const stub = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[{id:'test-model'}]})); return }
  let raw=''; for await (const p of req) raw+=p
  const body=JSON.parse(raw)
  const prompt=body.messages.filter(m=>m.role==='user').at(-1)?.content
  const text=typeof prompt==='string'?prompt:prompt?.filter(p=>p.type==='text').map(p=>p.text).join(' ')??''
  res.writeHead(200,{'content-type':'text/event-stream'})
  const chunk=(delta,finish=null)=>res.write(`data: ${JSON.stringify({id:'t',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`)
  chunk({content:'Fixture reply: '})
  await new Promise(r=>setTimeout(r, text.includes('slow') ? 4000 : 100))
  if (res.destroyed) return
  chunk({content:text.slice(0,80)||'done'}); chunk({}, 'stop')
  res.write(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:20,completion_tokens:10}})}\n\n`)
  res.end('data: [DONE]\n\n')
})
await new Promise(r=>stub.listen(0,'127.0.0.1',r))
// Something for the browser pane to point at — a dev server, as far as it knows.
const site = createServer((_req, res) => {
  res.writeHead(200, {'content-type':'text/html'})
  res.end('<!doctype html><title>Halaman Lokal</title><h1>Halaman Lokal</h1>')
})
await new Promise(r=>site.listen(0,'127.0.0.1',r))
const siteOrigin = `http://127.0.0.1:${site.address().port}`
const bootstrap = path.join(directory,'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env={...process.env,CLINEPASS_API_KEY:'fixture-key',CLINEPASS_BASE_URL:`http://127.0.0.1:${stub.address().port}/v1`,CLINEPASS_MODEL:'test-model',ANTICODE_REMOTE_PORT:'18681'}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({args:[bootstrap],env,cwd:directory})
const window = await app.firstWindow()
await window.setViewportSize({width:1280,height:820})
const shot = async (name) => { await window.screenshot({path:path.join(shots,name+'.png')}); console.log('shot:',name) }
const composer = () => window.getByPlaceholder(/Ask anything|Describe the task|Add to the task/)
try {
  const colourOf = async (locator) => locator.evaluate((el) => getComputedStyle(el).color)
  const LIME = 'rgb(209, 250, 34)'
  const check = (name, actual, expected) => {
    const ok = actual === expected
    console.log((ok ? 'PASS: ' : 'FAIL: ') + name, '->', actual)
    if (!ok) failures.push(`${name}: got ${actual}, want ${expected}`)
  }
  const failures = []
  /**
   * Chromium recomputes :hover from the real cursor whenever the app
   * re-renders — the status poll does, every five seconds — and the colour
   * transition itself takes 150ms. A single hover-then-read therefore catches
   * a half-finished colour often enough to fail for no reason, so each control
   * is re-hovered until its colour settles.
   */
  const colourOnHover = async (locator, want) => {
    const target = locator.first()
    let colour = ''
    for (let attempt = 0; attempt < 8 && colour !== want; attempt++) {
      await target.hover()
      await window.waitForTimeout(200)
      colour = await colourOf(target)
    }
    return colour
  }
  const limeOnHover = async (name, locator) => {
    check(name + ' turns lime on hover', await colourOnHover(locator, LIME), LIME)
  }
  await window.getByRole('button',{name:'antichat',exact:true}).waitFor()
  await shot('01-dashboard')
  const grid = window.getByTitle('Dashboard')
  check('grid icon stays lime on hover while dashboard is open', await colourOnHover(grid, LIME), LIME)
  await shot('02-dashboard-icon-hover-while-on-dashboard')

  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await composer().fill('halo dunia'); await composer().press('Enter')
  await window.getByText(/Fixture reply: halo dunia/).waitFor()
  await window.mouse.move(640, 400); await window.waitForTimeout(200)
  check('grid icon is faint inside a session, unhovered', await colourOf(grid), 'rgb(109, 109, 109)')
  await shot('03-in-session')
  check('grid icon turns lime on hover inside a session', await colourOnHover(grid, LIME), LIME)
  await shot('04-dashboard-icon-hover-inside-session')

  const usage = window.getByTitle('Session usage')
  await usage.click(); await window.waitForTimeout(200)
  await shot('05-usage-popover')
  await window.keyboard.press('Escape'); await window.waitForTimeout(300)
  const stillOpen = await window.getByText('Session usage').isVisible().catch(()=>false)
  check('Escape closes the usage popover', stillOpen ? 'still open' : 'closed', 'closed')
  await shot('06-after-escape-on-popover')

  const gear = window.getByTitle('Settings')
  await gear.click(); await window.waitForTimeout(400)
  check('gear lights lime while Settings is open', await colourOf(gear), LIME)
  await shot('07-settings')
  await gear.click(); await window.waitForTimeout(500)
  const backInSession = await window.getByText(/Fixture reply: halo dunia/).isVisible().catch(()=>false)
  check('closing Settings returns to the session it was opened from', backInSession ? 'session' : 'elsewhere', 'session')
  await shot('08-settings-toggled-off')

  await grid.click(); await window.waitForTimeout(300)
  await gear.click(); await window.waitForTimeout(400)
  await gear.click(); await window.waitForTimeout(500)
  const backOnDashboard = await window.getByPlaceholder('Describe the task…').isVisible().catch(()=>false)
  check('closing Settings returns to the dashboard it was opened from', backOnDashboard ? 'dashboard' : 'elsewhere', 'dashboard')
  await shot('09-settings-closed-back-to-dashboard')

  await composer().click()
  await window.getByText('Default',{exact:true}).click(); await window.waitForTimeout(250)
  await shot('10-mode-menu-open')
  await window.keyboard.press('Escape'); await window.waitForTimeout(300)
  await shot('11-mode-menu-after-escape')

  // A code session with no folder must refuse to send and point at Choose
  // folder, in the new-session tab exactly as on the dashboard. It used to
  // send anyway and surface a raw IPC error in the transcript.
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.waitForTimeout(400)
  await composer().fill('cek folder')
  await composer().press('Enter')
  await window.waitForTimeout(900)
  await shot('12-new-session-no-folder-after-enter')
  const leaked = await window.getByText(/needs a project folder|Error invoking/).count()
  check('folderless code session does not reach the provider', leaked === 0 ? 'refused' : 'sent', 'refused')
  const glowing = await window.getByRole('button',{name:/Choose folder/}).evaluate(
    (el) => el.className.includes('animate-glow')
  ).catch(() => false)
  check('Choose folder glows after a blocked send', glowing ? 'glowing' : 'inert', 'glowing')
  const kept = await composer().inputValue()
  check('the blocked draft is kept, not swallowed', kept, 'cek folder')

  // Attached files must read as files — a picture for an image, a card for the
  // rest — not as a bracketed list of names in the prompt text.
  await window.getByRole('button',{name:'New tab',exact:true}).click()
  await window.waitForTimeout(400)
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await window.waitForTimeout(200)
  const staged = await window.evaluate(async (file) => {
    const [info] = await window.anticode.addAttachments([file])
    const store = window.__store.getState()
    store.updateDraft(store.activeSessionId, { attachments: [info] })
    return { name: info.name, thumbnail: (info.thumbnail ?? '').slice(0, 23) }
  }, picture)
  check('an attached image carries a thumbnail', staged.thumbnail, 'data:image/jpeg;base64,')
  await window.waitForTimeout(300)
  await shot('13-composer-with-attachment')
  // Staged is not sent: the picture can be checked at full size first.
  await window.getByTitle('View tangkapan.png').click(); await window.waitForTimeout(400)
  check('a staged picture opens full size before sending',
    await window.getByRole('dialog', { name: 'tangkapan.png' }).count(), 1)
  await shot('13b-staged-picture-open')
  await window.keyboard.press('Escape'); await window.waitForTimeout(250)
  check('the staged picture closes on Escape',
    await window.getByRole('dialog', { name: 'tangkapan.png' }).count(), 0)
  await limeOnHover('composer: staged file name', window.locator('button.group\\/name span').first())
  await composer().fill('lihat gambar ini')
  await composer().press('Enter')
  await window.getByText(/Fixture reply/).last().waitFor()
  const drawn = await window.locator('img[alt="tangkapan.png"]').count()
  check('the sent image is drawn in the transcript', drawn > 0 ? 'drawn' : 'text only', 'drawn')
  const bracketed = await window.getByText('[tangkapan.png]').count()
  check('no bracketed filename is left in the prompt', bracketed === 0 ? 'clean' : 'bracketed', 'clean')
  await shot('14-attachment-in-transcript')

  // A file can be dropped anywhere in the session, not only on the text box:
  // here, on the transcript. It lands on the draft like the + button's would.
  const stagedCount = () => window.evaluate(() => {
    const state = window.__store.getState()
    return state.drafts[state.activeSessionId]?.attachments?.length ?? 0
  })
  const beforeDrop = await stagedCount()
  await window.evaluate(() => {
    const target = document.querySelector('[data-transcript]')
    window.__drop = new DataTransfer()
    window.__drop.items.add(new File(['halo dari file'], 'dijatuhkan.txt', { type: 'text/plain' }))
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: window.__drop }))
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__drop }))
  })
  await window.waitForTimeout(200)
  check('drop: the whole session offers to take the file',
    await window.getByText('Drop to attach').count(), 1)
  await shot('14b-drop-over-transcript')
  await window.evaluate(() => {
    const target = document.querySelector('[data-transcript]')
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__drop }))
  })
  await window.waitForTimeout(700)
  check('drop: a file dropped on the transcript is staged', await stagedCount(), beforeDrop + 1)
  check('drop: the sheet goes once the file lands', await window.getByText('Drop to attach').count(), 0)
  await window.evaluate(() => {
    const state = window.__store.getState()
    state.updateDraft(state.activeSessionId, { attachments: [] })
  })

  // A produced document is offered back, not just mentioned in a tool output.
  await window.evaluate(() => {
    const store = window.__store.getState()
    store.addMessage({
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'Laporannya sudah dibuat.' },
        {
          kind: 'tool',
          toolUseId: 'fixture-pdf',
          name: 'create_pdf',
          input: { path: 'laporan.pdf' },
          status: 'ok',
          output: 'Saved: laporan.pdf (1 pages)'
        }
      ],
      pending: false
    })
  })
  await window.waitForTimeout(300)
  const offered = await window.getByRole('button',{name:'Download',exact:true}).count()
  check('a produced document is offered for download', offered > 0 ? 'offered' : 'missing', 'offered')
  await shot('15-produced-document')

  // Lime is the one accent, and it marks what the cursor can touch: every icon
  // and every text button turns lime on hover. The rule is written down in
  // CLAUDE.md; this sweep is what keeps it from quietly rotting.

  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(400)
  await limeOnHover('dashboard: search icon', window.getByTitle('Search sessions'))
  await limeOnHover('dashboard: attach +', window.getByTitle('Attach files'))
  await limeOnHover('dashboard: model chip', window.locator('button:has(span.font-mono)'))
  await limeOnHover('dashboard: approval chip', window.getByText('Default',{exact:true}))
  await limeOnHover('dashboard: antichat label', window.getByRole('button',{name:'antichat',exact:true}))
  // A dead arrow does not light up; with words in the box it is live, and lime.
  await composer().fill('draft')
  await limeOnHover('dashboard: send arrow', window.getByRole('button',{name:'Send'}))
  await composer().fill('')
  await limeOnHover('dashboard: session row title', window.locator('.group button div.truncate'))
  await window.getByText('Default',{exact:true}).click(); await window.waitForTimeout(250)
  await limeOnHover('dashboard: approval menu hint', window.getByText('Skip prompts for medium risk'))
  await window.keyboard.press('Escape'); await window.waitForTimeout(250)

  // Deleting a session is destructive; red is a warning lime would erase.
  const DEL = 'rgb(224, 108, 108)'
  const destructive = window.getByRole('button',{name:'Delete session'})
  check('dashboard: delete stays red', await colourOnHover(destructive, DEL), DEL)
  await shot('16-lime-dashboard')

  await window.getByRole('button',{name:/Fixture reply|halo dunia/}).first().click().catch(() => {})
  await window.locator('header .group button').first().click(); await window.waitForTimeout(400)
  await limeOnHover('tab bar: usage icon', window.getByTitle('Session usage'))
  await limeOnHover('tab bar: browser icon', window.locator('[data-browser-toggle]'))
  await limeOnHover('tab bar: new tab +', window.getByRole('button',{name:'New tab',exact:true}))
  await limeOnHover('tab bar: close x', window.getByRole('button',{name:'Close tab'}))
  await limeOnHover('session: attach +', window.getByTitle('Attach files'))
  await composer().fill('draft')
  await limeOnHover('session: send arrow', window.getByRole('button',{name:'Send'}))
  await composer().fill('  ')
  check('session: an empty box leaves the send arrow dead',
    await window.getByRole('button',{name:'Send',exact:true}).isDisabled() ? 'dead' : 'live', 'dead')
  const sessionBefore = await window.evaluate(() => {
    const state = window.__store.getState()
    return state.sessions.find((s) => s.id === state.activeSessionId)?.messages.length
  })
  await composer().press('Enter'); await window.waitForTimeout(300)
  check('session: Enter on an empty box sends nothing', await window.evaluate(() => {
    const state = window.__store.getState()
    return state.sessions.find((s) => s.id === state.activeSessionId)?.messages.length
  }), sessionBefore)
  await composer().fill('')
  await limeOnHover('transcript: run summary',
    window.locator('div.group > div button').filter({ hasText: 'test-model' }))
  await limeOnHover('transcript: copy button', window.getByTitle('Copy this reply'))
  await shot('17-lime-session')

  // The browser pane takes the right-hand side; the transcript gives up width
  // for it instead of being covered, and hiding it hands that width back.
  const transcriptWidth = () =>
    window.locator('[data-transcript]').first().evaluate((el) => el.getBoundingClientRect().width)
  const wideBefore = await transcriptWidth()
  const browserToggle = window.locator('[data-browser-toggle]')
  await browserToggle.click(); await window.waitForTimeout(500)
  const pane = window.locator('[data-web-panel]')
  check('browser: the pane opens beside the transcript', await pane.count(), 1)
  const paneWidth = await pane.evaluate((el) => el.getBoundingClientRect().width)
  check('browser: the pane has real width', paneWidth > 300 ? 'wide' : `${paneWidth}px`, 'wide')
  const narrowed = await transcriptWidth()
  check('browser: the transcript shifts left', narrowed < wideBefore ? 'shifted' : 'unmoved', 'shifted')
  check('browser: the icon lights while the pane is open', await colourOf(browserToggle), LIME)
  await limeOnHover('browser: address bar reload', pane.getByTitle('Reload'))
  await limeOnHover('browser: hide button', pane.getByTitle('Hide browser'))
  // Typing an address is the other half of "anticode has a browser of its
  // own": the pane loads it without the agent being involved at all.
  await pane.getByLabel('Address').fill(siteOrigin)
  await window.keyboard.press('Enter')
  await window.waitForTimeout(900)
  const guest = pane.locator('webview')
  check('browser: an address typed in the pane loads', await guest.count(), 1)
  // The guest reports the page it settled on back to the main process, so the
  // src comes back normalised — a trailing slash the address bar never typed.
  const loaded = await guest.getAttribute('src')
  check('browser: the guest points where it was told',
    loaded.startsWith(siteOrigin) ? 'there' : loaded, 'there')
  check('browser: the address bar follows the page',
    await pane.getByLabel('Address').inputValue(), loaded)
  await shot('17b-browser-pane')

  // No dot on the icon, ever: the icon's own colour is the only state it has.
  check('browser: the tab-bar icon carries no dot',
    await browserToggle.locator('span').count(), 0)

  // Tabs: a second page beside the first, and the first is still there.
  await pane.getByRole('button', { name: 'New tab', exact: true }).click()
  await window.waitForTimeout(400)
  check('browser: a new tab opens', await pane.getByRole('button', { name: 'Close tab' }).count(), 2)
  await pane.getByLabel('Address').fill(siteOrigin + '/kedua')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(900)
  check('browser: each tab keeps its own page', await pane.locator('webview').count(), 2)
  const painted = await pane.locator('webview').evaluateAll((els) =>
    els.filter((el) => getComputedStyle(el).display !== 'none').length)
  check('browser: only the active tab is painted', painted, 1)
  await limeOnHover('browser: tab label', pane.getByRole('button', { name: 'Halaman Lokal' }).first())
  await limeOnHover('browser: new tab +', pane.getByRole('button', { name: 'New tab', exact: true }))
  await shot('17c-browser-tabs')

  const activeBeforeReport = await window.evaluate(async () =>
    (await window.anticode.listWebSessions())[0].activeTabId)
  await pane.locator('webview').first().evaluate((el) => {
    el.dispatchEvent(new CustomEvent('page-title-updated'))
  })
  await window.waitForTimeout(200)
  check('browser: a background title update keeps the selected tab',
    await window.evaluate(async () => (await window.anticode.listWebSessions())[0].activeTabId), activeBeforeReport)

  // Full size: the page takes the whole window, then gives it back.
  await pane.getByTitle('Fill the window').click()
  await window.waitForTimeout(500)
  const fullWidth = await pane.evaluate((el) => el.getBoundingClientRect().width)
  check('browser: full size takes the whole window',
    fullWidth >= 1270 ? 'whole' : `${fullWidth}px`, 'whole')
  check('browser: the transcript steps aside at full size',
    await window.locator('[data-transcript]').first().isVisible() ? 'visible' : 'aside', 'aside')
  check('browser: the full-size toggle lights while on',
    await colourOf(pane.getByTitle('Shrink to the side')), LIME)
  await shot('17d-browser-full')
  await pane.getByTitle('Shrink to the side').click()
  await window.waitForTimeout(500)
  check('browser: shrinking brings the transcript back',
    await window.locator('[data-transcript]').first().isVisible() ? 'visible' : 'aside', 'visible')
  await limeOnHover('browser: full-size toggle', pane.getByTitle('Fill the window'))

  await browserToggle.click()
  await window.mouse.move(400, 400)
  await window.waitForTimeout(500)
  const restored = await transcriptWidth()
  check('browser: hiding hands the width back', restored === wideBefore ? 'restored' : `${restored}`, 'restored')
  check('browser: the icon goes quiet again', await colourOf(browserToggle), 'rgb(154, 154, 154)')

  await window.locator('button:has(span.font-mono)').first().click(); await window.waitForTimeout(400)
  await limeOnHover('model picker: model row', window.locator('button.font-mono'))
  await limeOnHover('model picker: Reload', window.getByRole('button',{name:'Reload'}))
  await window.keyboard.press('Escape'); await window.waitForTimeout(250)

  await window.getByTitle('Settings').click(); await window.waitForTimeout(400)
  await limeOnHover('settings: sidebar section', window.getByRole('button',{name:/Providers/}))
  await window.getByRole('button',{name:/Providers/}).click(); await window.waitForTimeout(300)
  await limeOnHover('settings: add provider', window.getByRole('button',{name:'+ Add provider'}))
  await limeOnHover('settings: version line', window.locator('button.mt-auto'))

  // Inline code reads as plain white text in a box; the old purple was the
  // last colour in the app that meant nothing in particular.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.locator('header .group button').first().click(); await window.waitForTimeout(300)
  await window.evaluate(() => {
    const store = window.__store.getState()
    store.addMessage({ id: crypto.randomUUID(), role: 'assistant',
      parts: [{ kind: 'text', text: 'Cek `ErrorComponent` di sana.' }], pending: false })
  })
  await window.waitForTimeout(300)
  const chip = window.locator('code').first()
  const chipStyle = await chip.evaluate((el) => {
    const s = getComputedStyle(el)
    return { colour: s.color, background: s.backgroundColor, padding: s.paddingLeft, radius: s.borderRadius }
  })
  check('transcript: inline code is white', chipStyle.colour, 'rgb(237, 237, 237)')
  check('transcript: inline code keeps its box', chipStyle.background, 'rgb(39, 39, 39)')
  check('transcript: inline code keeps its padding', chipStyle.padding, '6px')
  await shot('19-inline-code')
  await window.getByTitle('Settings').click(); await window.waitForTimeout(400)

  // A switch that is on carries the accent on its track, not a stray green.
  await window.getByRole('button',{name:/General/}).click(); await window.waitForTimeout(300)
  const toggle = window.getByRole('switch').first()
  const trackOf = () => toggle.evaluate((el) => getComputedStyle(el).backgroundColor)
  await toggle.click(); await window.waitForTimeout(300)
  check('settings: a switch that is on is lime', await trackOf(), LIME)
  await shot('18-lime-settings')
  await toggle.click(); await window.waitForTimeout(300)
  check('settings: a switch that is off is grey', await trackOf(), 'rgb(46, 46, 46)')

  // Pausing and resuming are the app talking about itself: a grey line on the
  // left in the same voice a tool group uses — never a bubble on the right,
  // which would read as something the user typed.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await composer().fill('slow please'); await composer().press('Enter')
  await window.waitForTimeout(700)
  await window.getByRole('button',{name:'Pause'}).click(); await window.waitForTimeout(500)
  const pauseLine = window.getByText('Okay, Take a break mate!')
  check('pause: the marker is in the transcript', await pauseLine.count() > 0 ? 'said' : 'silent', 'said')
  const markerStyle = await pauseLine.evaluate((el) => {
    const s = getComputedStyle(el)
    return { colour: s.color, background: s.backgroundColor, radius: s.borderTopLeftRadius,
             left: Math.round(el.getBoundingClientRect().left) }
  })
  // The session tab carries the same words; the bubble is the div in the body.
  const bubbleLeft = await window.locator('div.rounded-xl', { hasText: 'slow please' }).last().evaluate(
    (el) => Math.round(el.getBoundingClientRect().left))
  check('pause: the marker is grey', markerStyle.colour, 'rgb(154, 154, 154)')
  check('pause: the marker has no bubble', markerStyle.background + ' ' + markerStyle.radius, 'rgba(0, 0, 0, 0) 0px')
  check('pause: the marker sits left of the user bubble', markerStyle.left < bubbleLeft ? 'left' : 'right', 'left')
  check('pause: the marker turns lime on hover', await colourOnHover(pauseLine, LIME), LIME)
  await shot('20-pause-marker')

  // Paused, the button resumes — with a play mark, not the send arrow, which
  // read as sending an empty prompt. Typing turns it back into a send.
  const resumeButton = window.getByRole('button',{name:'Resume'})
  check('pause: resume wears a play mark, not an arrow',
    await resumeButton.locator('svg path').getAttribute('d').then((d) => d.startsWith('M5 3.2') ? 'play' : 'arrow'), 'play')
  await composer().fill('ganti rencana')
  check('pause: typing turns resume into send', await window.getByRole('button',{name:'Send',exact:true}).count(), 1)
  await composer().fill('')
  check('pause: an empty box goes back to resume', await resumeButton.count(), 1)
  await resumeButton.click(); await window.waitForTimeout(900)
  const resumeLine = window.getByText('ah sh**, here we go again')
  check('resume: the marker is in the transcript', await resumeLine.count() > 0 ? 'said' : 'silent', 'said')
  check('resume: the marker is grey',
    await resumeLine.evaluate((el) => getComputedStyle(el).color), 'rgb(154, 154, 154)')
  const typed = await window.evaluate(() =>
    window.__store.getState().sessions.flatMap((s) => s.messages)
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .filter((p) => p.kind === 'text' && p.text.startsWith('Lanjutkan pekerjaan')).length)
  check('resume: the continuation paragraph stays out of the transcript', typed === 0 ? 'hidden' : 'shown', 'hidden')
  await shot('21-resume-marker')

  // An instruction sent while the session is working joins that run: the box
  // empties at once, the instruction shows as sent, the app reacts in its own
  // voice, and the run carries on to answer both — one run, one closing line.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  // An empty box sends nothing — not by Enter, not by the button, which is
  // dead rather than pressable-and-silent.
  const everything = () => window.evaluate(() => {
    const state = window.__store.getState()
    return `${state.sessions.length}/${state.sessions.reduce((sum, s) => sum + s.messages.length, 0)}`
  })
  const beforeEmpty = await everything()
  await composer().fill('   ')
  await composer().press('Enter'); await window.waitForTimeout(300)
  check('dashboard: an empty box leaves the send arrow dead',
    await window.getByRole('button',{name:'Send',exact:true}).isDisabled() ? 'dead' : 'live', 'dead')
  await window.getByRole('button',{name:'Send',exact:true}).click({ force: true }); await window.waitForTimeout(300)
  check('dashboard: an empty box sends nothing', await everything(), beforeEmpty)
  await composer().fill('slow first'); await composer().press('Enter')
  await window.waitForTimeout(700)
  check('follow-up: an empty box offers pause', await window.getByRole('button',{name:'Pause',exact:true}).count(), 1)
  await composer().fill('tambah ini')
  check('follow-up: typing turns pause into send', await window.getByRole('button',{name:'Send',exact:true}).count(), 1)
  await composer().press('Enter'); await window.waitForTimeout(500)
  check('follow-up: the box empties at once', await composer().inputValue(), '')
  const followMarker = window.getByText('wait a minutes, bi***')
  check('follow-up: the marker is written', await followMarker.count() > 0 ? 'said' : 'silent', 'said')
  check('follow-up: the marker is grey', await followMarker.first().evaluate((el) => getComputedStyle(el).color), 'rgb(154, 154, 154)')
  check('follow-up: the instruction shows as sent',
    await window.locator('div.rounded-xl', { hasText: 'tambah ini' }).count() > 0 ? 'sent' : 'missing', 'sent')
  await window.getByText(/Fixture reply: \[Pesan tambahan/).waitFor({ timeout: 15000 })
  await window.waitForTimeout(500)
  const followRun = await window.evaluate(() => {
    const state = window.__store.getState()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    const text = (m) => m.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('')
    const replies = session.messages.filter((m) => m.role === 'assistant' && !m.parts.some((p) => p.kind === 'notice'))
    return {
      firstReply: text(replies[0] ?? { parts: [] }),
      closing: session.messages.filter((m) => m.summary !== undefined).length,
      order: session.messages.map((m) => m.role === 'user' ? 'user' : m.parts.some((p) => p.kind === 'notice') ? 'notice' : 'reply')
    }
  })
  check('follow-up: the run answers both, and closes once', followRun.closing, 1)
  check('follow-up: instruction, reaction, then the reply', followRun.order.join(' '), 'user reply user notice reply')
  // What the run was still writing when the instruction arrived stays above it.
  check('follow-up: the reply in progress finishes above it', followRun.firstReply, 'Fixture reply: slow first')
  await shot('21b-follow-up')

  // The line that closes a run: model, copy, how long, what it cost — no dot.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await composer().fill('ringkasan'); await composer().press('Enter')
  await window.getByText(/Fixture reply: ringkasan/).waitFor(); await window.waitForTimeout(500)
  const closing = window.locator('div.group > div').filter({ hasText: 'test-model' }).last()
  const parts = await closing.evaluate((el) => el.textContent)
  check('closing line names the model first', parts.startsWith('test-model') ? 'model' : parts.slice(0,20), 'model')
  check('closing line reports tokens', /\d+ tokens/.test(parts) ? 'reported' : parts, 'reported')
  check('closing line has no status dot', await closing.locator('span.bg-add').count(), 0)
  const copyButton = closing.getByTitle('Copy this reply')
  check('closing line offers a copy button', await copyButton.count(), 1)
  check('the copy button sits between the model and the timing',
    await closing.evaluate((el) => {
      const kids = [...el.children]
      return kids.findIndex((k) => k.getAttribute('title') === 'Copy this reply') === 1 ? 'between' : 'elsewhere'
    }), 'between')
  await copyButton.click(); await window.waitForTimeout(300)
  const clipped = await window.evaluate(() => navigator.clipboard.readText())
  check('copying yields the reply and its cost',
    clipped.includes('Fixture reply: ringkasan') && /\d+ tokens/.test(clipped) ? 'both' : clipped.slice(0,40), 'both')
  await shot('22-closing-line')

  // Selecting part of a reply offers to answer that passage: the quote rides
  // above the composer and travels with the prompt.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await composer().fill('kutip aku'); await composer().press('Enter')
  await window.getByText(/Fixture reply: kutip aku/).waitFor(); await window.waitForTimeout(400)
  await window.evaluate(() => {
    const node = [...document.querySelectorAll('[data-transcript] div')].find(
      (el) => el.textContent.trim() === 'Fixture reply: kutip aku' && el.children.length === 0)
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await window.waitForTimeout(300)
  const balas = window.getByRole('button',{name:'Balas',exact:true})
  check('selecting a reply offers Balas', await balas.count(), 1)
  await balas.click(); await window.waitForTimeout(300)
  check('the quote lands above the composer',
    await window.getByText('Membalas').count() > 0 ? 'shown' : 'missing', 'shown')
  // A long passage must not swallow the composer, and the card dismisses like
  // the popup it looks like — clicking away, or Escape.
  const card = window.locator('div').filter({ hasText: /^Membalas/ }).last()
  check('the quoted passage is clamped', await card.locator('span.line-clamp-3').evaluate(
    (el) => getComputedStyle(el).webkitLineClamp), '3')
  await shot('23-reply-to-selection')
  await window.mouse.click(640, 200); await window.waitForTimeout(300)
  check('clicking away drops the quote',
    await window.getByText('Membalas').count() === 0 ? 'dropped' : 'stuck', 'dropped')
  await window.evaluate(() => {
    const node = [...document.querySelectorAll('[data-transcript] div')].find(
      (el) => el.textContent.trim() === 'Fixture reply: kutip aku' && el.children.length === 0)
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await window.waitForTimeout(300)
  await window.getByRole('button',{name:'Balas',exact:true}).click(); await window.waitForTimeout(300)
  await window.keyboard.press('Escape'); await window.waitForTimeout(300)
  check('Escape drops the quote',
    await window.getByText('Membalas').count() === 0 ? 'dropped' : 'stuck', 'dropped')
  // Put it back for the send check below.
  await window.evaluate(() => {
    const node = [...document.querySelectorAll('[data-transcript] div')].find(
      (el) => el.textContent.trim() === 'Fixture reply: kutip aku' && el.children.length === 0)
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await window.waitForTimeout(300)
  await window.getByRole('button',{name:'Balas',exact:true}).click(); await window.waitForTimeout(300)
  await composer().fill('jelaskan ini')
  await composer().press('Enter')
  await window.waitForTimeout(900)
  const quoted = await window.evaluate(() =>
    window.__store.getState().sessions.flatMap((s) => s.messages)
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.parts)
      .some((p) => p.kind === 'text' && p.text.startsWith('> Fixture reply: kutip aku') && p.text.includes('jelaskan ini')))
  check('the quote is sent with the prompt', quoted ? 'sent' : 'lost', 'sent')
  check('the quote chip clears after sending',
    await window.getByText('Membalas').count() === 0 ? 'cleared' : 'stuck', 'cleared')

  // Pausing offers to take the last prompt back for editing.
  await composer().fill('slow please'); await composer().press('Enter')
  await window.waitForTimeout(700)
  await window.getByRole('button',{name:'Pause'}).click(); await window.waitForTimeout(500)
  const revert = window.getByRole('button',{name:/Revert/})
  check('pausing offers Revert', await revert.count(), 1)
  await revert.click(); await window.waitForTimeout(700)
  check('reverting puts the prompt back in the box', await composer().inputValue(), 'slow please')
  // Scoped to this session: an earlier check sends the same words elsewhere.
  const gone = await window.evaluate(() => {
    const state = window.__store.getState()
    const session = state.sessions.find((s) => s.id === state.activeSessionId)
    return (session?.messages ?? [])
      .flatMap((m) => m.parts)
      .some((p) => p.kind === 'text' && p.text === 'slow please')
  })
  check('reverting removes the turn from the transcript', gone ? 'still there' : 'gone', 'gone')
  await shot('24-reverted')

  // A prompt the model drafted reads as a panel in the mono face, with a copy
  // control above and below it — not as another paragraph of prose.
  // Into a real session view, so the transcript is on screen to render into.
  await window.getByTitle('Dashboard').click(); await window.waitForTimeout(300)
  await window.locator('header .group button').first().click(); await window.waitForTimeout(400)
  await window.evaluate(() => {
    const store = window.__store.getState()
    store.addMessage({ id: crypto.randomUUID(), role: 'assistant', parts: [{ kind: 'text', text:
      'Berikut contoh prompt untuk membuat foto Gunung Everest 4K:\n\n' +
      '"Ultra-realistic photograph of Mount Everest at 4K resolution, majestic snow-capped peak ' +
      'touching a clear blue sky, golden hour sunlight hitting the summit, National Geographic style"\n\n' +
      'Catatan: saya hanya mode tanya-jawab.' }], pending: false })
  })
  await window.waitForTimeout(400)
  const panel = window.locator('pre').filter({ hasText: 'Ultra-realistic photograph' })
  check('a drafted prompt gets its own panel', await panel.count(), 1)
  const face = await panel.evaluate((el) => getComputedStyle(el).fontFamily)
  const chipFace = await window.locator('span.font-mono').first().evaluate((el) => getComputedStyle(el).fontFamily)
  check('the panel wears the model-name face', face === chipFace ? 'same' : `${face} vs ${chipFace}`, 'same')
  check('the quotes are stripped from the panel',
    (await panel.textContent()).trim().startsWith('Ultra-realistic') ? 'stripped' : 'kept', 'stripped')
  const block = window.locator('div').filter({ has: panel }).last()
  check('a copy control sits above and below the panel',
    await block.getByRole('button',{name:/Copy/}).count(), 2)
  check('the prose around it stays prose',
    await window.getByText('Berikut contoh prompt untuk membuat foto Gunung Everest 4K:').count(), 1)
  await block.getByRole('button',{name:/Copy/}).first().click(); await window.waitForTimeout(300)
  const copiedPrompt = await window.evaluate(() => navigator.clipboard.readText())
  check('copying yields the prompt without its quotes',
    copiedPrompt.startsWith('Ultra-realistic') && copiedPrompt.endsWith('style') ? 'clean' : copiedPrompt.slice(0,30), 'clean')
  await shot('25-prompt-panel')

  // A ticked checklist item wears the green mark; an unticked bullet keeps its
  // plain dot, so the tick still means something.
  await window.evaluate(() => {
    const store = window.__store.getState()
    store.addMessage({ id: crypto.randomUUID(), role: 'assistant', parts: [{ kind: 'text', text:
      '- HANDLE PINTU ATAS LH = 5 \u2713\n- BLOWER AC = 6 \u2713\n- [x] SPION KOTAK RH = 13\n- belum dicek' }],
      pending: false })
  })
  await window.waitForTimeout(400)
  const ticked = await window.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-transcript] div')]
      .filter((el) => /HANDLE PINTU ATAS LH|SPION KOTAK RH|belum dicek/.test(el.textContent) && el.querySelector('div') === null)
    return rows.map((el) => ({ text: el.textContent, green: el.textContent.includes('\u2705') }))
  })
  check('a trailing check becomes the green mark',
    ticked.find((r) => r.text.includes('HANDLE PINTU'))?.green === true ? 'green' : 'plain', 'green')
  check('the bare glyph is gone',
    ticked.some((r) => r.text.includes('\u2713')) ? 'still there' : 'replaced', 'replaced')
  check('a markdown task box becomes the green mark',
    ticked.find((r) => r.text.includes('SPION KOTAK RH'))?.green === true ? 'green' : 'plain', 'green')
  check('an unticked bullet stays plain',
    ticked.find((r) => r.text.includes('belum dicek'))?.green === false ? 'plain' : 'green', 'plain')
  await shot('26-checklist')

  console.log(JSON.stringify({shots,directory}))
  if (failures.length > 0) { console.error('FAILURES:', failures); process.exitCode = 1 }
  if (process.argv.includes('--keep-open')) await new Promise(()=>{})
} finally {
  if (!process.argv.includes('--keep-open')) { await app.close(); await new Promise(r=>stub.close(r)); await new Promise(r=>site.close(r)) }
}
