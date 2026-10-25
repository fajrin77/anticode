import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
export interface OAuthClient { id: string; secret: string }
/** Inspect installed configuration only; never execute a bundle or read account tokens. */
export function clientFromRouterBundle(source: string): OAuthClient | undefined {
  const start = source.search(/id:["']antigravity["']/)
  if (start < 0) return undefined
  const section = source.slice(start, start + 5000).split(/\},\{id:/)[0]!
  const pair = /clientId:["']([^"']+)["'],clientSecret:["']([^"']+)["']/.exec(section)
  return pair ? { id: pair[1]!, secret: pair[2]! } : undefined
}
export function antigravityOAuthClient(): OAuthClient {
  const id = process.env.ANTICODE_ANTIGRAVITY_CLIENT_ID?.trim()
  const secret = process.env.ANTICODE_ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (id && secret) return { id, secret }
  if (id || secret) throw new Error('Set both Antigravity OAuth client values, or remove both to use the installed 9router configuration.')
  const roots = [process.env.ANTICODE_9ROUTER_PATH, path.join(homedir(), '.npm-global/lib/node_modules/9router'), '/usr/local/lib/node_modules/9router', '/opt/homebrew/lib/node_modules/9router'].filter((root): root is string => !!root)
  for (const root of roots) {
    const dir = path.join(root, 'app/.next-cli-build/server/chunks')
    try {
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.js')).slice(0, 1000)) {
        const source = readFileSync(path.join(dir, file), 'utf8')
        if (source.length > 4_000_000) continue
        const client = clientFromRouterBundle(source)
        if (client) return client
      }
    } catch { /* Try the next installation. */ }
  }
  throw new Error('Antigravity needs an OAuth client. Install 9router locally (or set ANTICODE_9ROUTER_PATH to its package folder), or configure ANTICODE_ANTIGRAVITY_CLIENT_ID and ANTICODE_ANTIGRAVITY_CLIENT_SECRET. Account authorization still happens in your browser.')
}
