// UI inspection harness: launches the app on a temp profile with a local stub
// provider and captures the states worth looking at. No real credentials, no
// paid API calls. Screenshots land in the directory printed at the end.
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const directory = await mkdtemp(path.join(tmpdir(), 'anticode-ui-'))
const profile = path.join(directory, 'profile'); await mkdir(profile)
const workspace = path.join(directory, 'workspace'); await mkdir(workspace)
await writeFile(path.join(workspace, 'hello.txt'), 'original')
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
const bootstrap = path.join(directory,'bootstrap.cjs')
await writeFile(bootstrap, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(path.resolve('out/main/index.js'))});`)
const env={...process.env,CLINEPASS_API_KEY:'fixture-key',CLINEPASS_BASE_URL:`http://127.0.0.1:${stub.address().port}/v1`,CLINEPASS_MODEL:'test-model',ANTICODE_REMOTE_PORT:'18681'}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({args:[bootstrap],env,cwd:directory})
const window = await app.firstWindow()
await window.setViewportSize({width:1280,height:820})
const shot = async (name) => { await window.screenshot({path:path.join(shots,name+'.png')}); console.log('shot:',name) }
const composer = () => window.getByPlaceholder(/Ask anything|Describe the task/)
try {
  const colourOf = async (locator) => locator.evaluate((el) => getComputedStyle(el).color)
  const LIME = 'rgb(209, 250, 34)'
  const check = (name, actual, expected) => {
    const ok = actual === expected
    console.log((ok ? 'PASS: ' : 'FAIL: ') + name, '->', actual)
    if (!ok) failures.push(`${name}: got ${actual}, want ${expected}`)
  }
  const failures = []
  await window.getByRole('button',{name:'antichat',exact:true}).waitFor()
  await shot('01-dashboard')
  const grid = window.getByTitle('Dashboard')
  await grid.hover(); await window.waitForTimeout(250)
  check('grid icon stays lime on hover while dashboard is open', await colourOf(grid), LIME)
  await shot('02-dashboard-icon-hover-while-on-dashboard')

  await window.getByRole('button',{name:'antichat',exact:true}).click()
  await composer().fill('halo dunia'); await composer().press('Enter')
  await window.getByText(/Fixture reply: halo dunia/).waitFor()
  await window.mouse.move(640, 400); await window.waitForTimeout(200)
  check('grid icon is faint inside a session, unhovered', await colourOf(grid), 'rgb(109, 109, 109)')
  await shot('03-in-session')
  await grid.hover(); await window.waitForTimeout(300)
  check('grid icon turns lime on hover inside a session', await colourOf(grid), LIME)
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

  console.log(JSON.stringify({shots,directory}))
  if (failures.length > 0) { console.error('FAILURES:', failures); process.exitCode = 1 }
  if (process.argv.includes('--keep-open')) await new Promise(()=>{})
} finally {
  if (!process.argv.includes('--keep-open')) { await app.close(); await new Promise(r=>stub.close(r)) }
}
