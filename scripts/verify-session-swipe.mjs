// Regression checks on the real Electron renderer, with isolated local state.
import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const directory = await mkdtemp(path.join(tmpdir(), 'anticode-swipe-'))
const profile = path.join(directory, 'profile')
await mkdir(profile)
const bootstrap = path.join(directory, 'bootstrap.cjs')
await writeFile(bootstrap, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env = { ...process.env, ANTICODE_REMOTE_PORT: '0' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({args:[bootstrap],env,cwd:directory})
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.getByRole('button',{name:'New tab',exact:true}).waitFor()
  for (let i=0;i<4;i++) {
    await page.getByRole('button',{name:'New tab',exact:true}).click()
  }
  await page.evaluate(() => {
    window.__store.setState(state => ({ sessions: state.sessions.map((session, i) => ({
      ...session, mode: 'chat', title: `Swipe audit ${i + 1}`,
      messages: [{ id: crypto.randomUUID(), role: 'assistant', pending: false,
        parts: [{kind: 'text', text: `Conversation ${i + 1}\n\n` + 'A paragraph for transcript scrolling.\n\n'.repeat(40)}] }]
    })) }))
  })
  const tabs = page.locator('[data-session-tabs] > div')
  assert.equal(await tabs.count(),4)
  const select = async i => { await tabs.nth(i).locator('button').first().click(); await page.waitForTimeout(300) }
  const active = () => tabs.evaluateAll(nodes=>nodes.findIndex(n=>n.classList.contains('glass-control')))
  const wheel = async (selector,x,y=0) => page.locator(selector).first().evaluate((el,{x,y})=>{
    const event=new WheelEvent('wheel',{deltaX:x,deltaY:y,bubbles:true,cancelable:true})
    el.dispatchEvent(event)
    return event.defaultPrevented
  },{x,y})
  const settle = () => page.waitForTimeout(380)
  await select(1)
  assert.equal(await wheel('[data-session-swipe]',18),true)
  await page.waitForTimeout(40)
  assert.equal(await active(),1,'small gesture must not switch immediately')
  assert.equal(await page.locator('[data-session-slide]').evaluate(el=>el.style.transform),'','session pane must not slide sideways')
  await settle()
  assert.equal(await active(),1,'short gesture springs back')
  for(let i=0;i<4;i++){await wheel('[data-session-swipe]',12);await page.waitForTimeout(15)}
  await page.waitForTimeout(40)
  assert.equal(await active(),1,'a gesture still in flight must not switch yet')
  await settle()
  assert.equal(await active(),2,'release commits exactly one neighbour')
  const layering = await page.evaluate(() => {
    const pane = document.querySelector('[data-session-slide]')
    const tabs = document.querySelector('[data-session-tabs]')
    if (!(pane instanceof HTMLElement) || !(tabs instanceof HTMLElement)) return null
    return {
      local: getComputedStyle(pane).viewTransitionName === 'none',
      belowTabs: pane.getBoundingClientRect().top >= tabs.getBoundingClientRect().bottom
    }
  })
  assert.deepEqual(layering,{local:true,belowTabs:true},'session animation must stay clipped below the tab bar')
  await page.waitForTimeout(200)
  await page.screenshot({path:path.join(directory,'conversation.png')})
  console.log('PASS: chat surface holds still, then commits one neighbour on release')
  await wheel('[data-session-tabs]',-180);await settle()
  assert.equal(await active(),1,'tab strip shares the gesture recognizer')
  assert.equal(await wheel('[data-session-swipe]',10,80),false)
  await settle();assert.equal(await active(),1)
  assert.equal(await wheel('[data-composer]',180),false)
  await settle();assert.equal(await active(),1)
  await page.locator('[data-session-swipe]').evaluate(el=>{
    const pre=document.createElement('pre');pre.id='swipe-scroll-fixture';pre.style.cssText='width:120px;overflow-x:auto';pre.textContent='wide code '.repeat(100);el.prepend(pre)
  })
  assert.equal(await wheel('#swipe-scroll-fixture',180),false)
  await settle();assert.equal(await active(),1)
  console.log('PASS: tab strip works; vertical scroll, composer and wide code keep their gestures')
  await select(0);await wheel('[data-session-swipe]',-180);await settle();assert.equal(await active(),0)
  await select(3);await wheel('[data-session-swipe]',180);await settle();assert.equal(await active(),3)
  await select(1)
  await page.locator('[data-composer]').fill('draft survives swipe')
  await wheel('[data-session-swipe]',180);await settle()
  assert.equal(await active(),2,'draft check moves to the next session')
  await wheel('[data-session-swipe]',-180);await settle()
  assert.equal(await active(),1,'draft check returns to the original session')
  assert.equal(await page.locator('[data-composer]').inputValue(),'draft survives swipe')
  console.log('PASS: no boundary wrapping; draft survives leaving and returning')
  await select(1)
  // Very small deltas still accumulate: slow deliberate slides must work too.
  for(let i=0;i<80;i++){await wheel('[data-transcript]',1.5);await page.waitForTimeout(5)}
  await settle();assert.equal(await active(),2)
  // A click during the release delay must win over a stale swipe.
  await wheel('[data-transcript]',-180)
  await select(3);await settle();assert.equal(await active(),3)
  await select(1)
  console.log('PASS: slow trackpad deltas accumulate; direct selection cancels a pending slide')
  await page.emulateMedia({reducedMotion:'reduce'})
  await wheel('[data-session-swipe]',180);await settle();assert.equal(await active(),2)
  await page.getByTitle('Settings',{exact:true}).click()
  await wheel('[data-session-tabs]',-180);await settle();assert.equal(await active(),2)
  console.log('PASS: reduced motion works; settings does not accidentally switch sessions')
  assert.deepEqual(errors,[])
  await page.screenshot({path:path.join(directory,'verified.png')})
  console.log(JSON.stringify({directory}))
} finally { await app.close() }
