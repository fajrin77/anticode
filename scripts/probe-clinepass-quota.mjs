// Read-only live quota probe. Never logs keys, account identities, or response bodies.
import { _electron as electron } from 'playwright'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
const dir = await mkdtemp(path.join(tmpdir(), 'anticode-pass-quota-'))
await writeFile(path.join(dir, 'settings.json'), JSON.stringify({remote:{enabled:false},updates:{autoCheck:false}}))
const root = path.join(homedir(), 'Library/Application Support/anticode')
const providers = JSON.parse(await readFile(path.join(root, 'providers.json'), 'utf8')).providers
const accounts = JSON.parse(await readFile(path.join(root, 'auth-accounts.json'), 'utf8')).accounts
const config = providers.find(p=>p.id==='clinepass') ?? {sealed: accounts.find(row=>row.account.kind==='clinepass')?.sealed}
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({executablePath:'/Applications/anticode.app/Contents/MacOS/anticode',args:['--user-data-dir='+dir],env})
try {
  const result = await app.evaluate(async ({safeStorage}, config) => {
    if (!config?.apiKey && !config?.sealed) return {error:'No saved ClinePass connection'}
    const decode = value => value.startsWith('safe:v1:') ? safeStorage.decryptString(Buffer.from(value.slice(8),'base64')) : value
    const raw = config.apiKey ? decode(config.apiKey) : JSON.parse(decode(config.sealed)).accessToken
    const key = /^eyJ[\w-]+\.[\w-]+\./.test(raw) ? 'workos:'+raw : raw
    const output=[]
    for (const endpoint of ['/users/me/plan/usage-limits','/users/me/plan']) {
      try {
        const r=await fetch('https://api.cline.bot/api/v1'+endpoint,{headers:{authorization:'Bearer '+key,accept:'application/json'},signal:AbortSignal.timeout(15000)})
        const d=await r.json().catch(()=>null)
        function shape(v,depth=0) {
          if(depth>5)return typeof v
          if(Array.isArray(v))return v.slice(0,4).map(x=>shape(x,depth+1))
          if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([k])=>!/token|key|email|user|account|customer|stripe|(^id$)/i.test(k)).map(([k,x])=>[k,shape(x,depth+1)]))
          if(typeof v==='number'||typeof v==='boolean')return v
          if(typeof v==='string' && (/^\d{4}-\d\d-\d\dT/.test(v)||['five_hour','weekly','monthly','active','clinepass','ClinePass'].includes(v)))return v
          return typeof v
        }
        output.push({endpoint,status:r.status,data:shape(d)})
      } catch {output.push({endpoint,error:'network/timeout'})}
    }
    return output
  }, config)
  console.log(JSON.stringify(result))
} finally {await app.close()}
