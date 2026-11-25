import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
export interface OAuthClient { id: string; secret: string }

/*
 * OAuth clients are never stored here: the repository would carry a vendor
 * credential, and a rotated one would leave every install broken. They come
 * from the environment or from a locally installed CLI bundle.
 */

/** Inspect installed configuration only; never execute a bundle or read account tokens. */
export function clientFromRouterBundle(source: string, provider = 'antigravity'): OAuthClient | undefined {
  const start = source.search(new RegExp(`id:["']${provider}["']`))
  if (start < 0) return undefined
  const section = source.slice(start, start + 5000).split(/\},\{id:/)[0]!
  const pair = /clientId:["']([^"']+)["'],clientSecret:["']([^"']+)["']/.exec(section)
  return pair ? { id: pair[1]!, secret: pair[2]! } : undefined
}

const installedCache = new Map<string, OAuthClient | null>()

/** A client read from the installed 9router bundle, when one is installed. */
function installedClient(provider: string): OAuthClient | undefined {
  const cacheKey = `${process.env.ANTICODE_9ROUTER_PATH ?? ''}:${provider}`
  if (installedCache.has(cacheKey)) return installedCache.get(cacheKey) ?? undefined
  const roots = [process.env.ANTICODE_9ROUTER_PATH, path.join(homedir(), '.npm-global/lib/node_modules/9router'), '/usr/local/lib/node_modules/9router', '/opt/homebrew/lib/node_modules/9router'].filter((root): root is string => !!root)
  for (const root of roots) {
    const dir = path.join(root, 'app/.next-cli-build/server/chunks')
    try {
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.js')).slice(0, 1000)) {
        const source = readFileSync(path.join(dir, file), 'utf8')
        if (source.length > 4_000_000) continue
        const client = clientFromRouterBundle(source, provider)
        if (client) {
          installedCache.set(cacheKey, client)
          return client
        }
      }
    } catch { /* Try the next installation. */ }
  }
  installedCache.set(cacheKey, null)
  return undefined
}

function oauthClient(provider: string, envId: string | undefined, envSecret: string | undefined, hint: string): OAuthClient {
  const id = envId?.trim()
  const secret = envSecret?.trim()
  if (id && secret) return { id, secret }
  if (id || secret) throw new Error(`Set both OAuth client values for ${provider}, or remove both.`)
  const installed = installedClient(provider)
  if (installed) return installed
  throw new Error(hint)
}

export function antigravityOAuthClient(): OAuthClient {
  return oauthClient('antigravity', process.env.ANTICODE_ANTIGRAVITY_CLIENT_ID, process.env.ANTICODE_ANTIGRAVITY_CLIENT_SECRET, 'Antigravity needs an OAuth client. Install 9router locally (or set ANTICODE_9ROUTER_PATH to its package folder), or configure ANTICODE_ANTIGRAVITY_CLIENT_ID and ANTICODE_ANTIGRAVITY_CLIENT_SECRET. Account authorization still happens in your browser.')
}

/** The Gemini CLI's own client, from the same local sources as Antigravity. */
export function geminiOAuthClient(): OAuthClient {
  return oauthClient('gemini-cli', process.env.ANTICODE_GEMINI_CLIENT_ID, process.env.ANTICODE_GEMINI_CLIENT_SECRET, 'The Gemini plan sign-in needs an OAuth client. Install 9router locally (or set ANTICODE_9ROUTER_PATH to its package folder), or set ANTICODE_GEMINI_CLIENT_ID and ANTICODE_GEMINI_CLIENT_SECRET. Account authorization still happens in your browser.')
}
