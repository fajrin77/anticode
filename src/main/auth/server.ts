import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/*
 * The little localhost server OAuth flows hand their redirect to. It listens
 * on the first free port from a list, resolves with the query string of the
 * first request, and shuts itself down. Vendors like Codex expect a fixed
 * port (1455); the others just need *a* port we can put in the URL.
 */

export interface CallbackResult {
  code: string
  state: string
  error?: string
}

const SUCCESS_HTML = `<!doctype html><meta charset="utf-8">
<title>anticode</title>
<body style="background:#0b0b0c;color:#e5e5e7;font:15px -apple-system,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="color:#d1fa22;font-size:22px;margin-bottom:8px">Signed in</div>
<div>You can close this window and go back to anticode.</div></div>
</body>`

const ERROR_HTML = `<!doctype html><meta charset="utf-8">
<title>anticode</title>
<body style="background:#0b0b0c;color:#e5e5e7;font:15px -apple-system,system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><div style="color:#f87171;font-size:22px;margin-bottom:8px">Sign-in was not completed</div>
<div>You can close this window and return to anticode.</div></div>
</body>`

export interface LocalServerOptions {
  /** Ports to try in order; the first that binds is used. */
  ports: number[]
  /** Path the redirect must land on; anything else gets 404. */
  path: string
  /** Aborts the wait and shuts the server down. */
  signal?: AbortSignal
  /** Called once the port is known, so the caller can build the URL. */
  onListening?: (port: number) => void
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host.trim())
}

/**
 * Waits for one OAuth redirect. The promise resolves with the parsed query,
 * or rejects when the signal aborts or the caller's port list is exhausted.
 */
export function waitForCallback(options: LocalServerOptions): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Login cancelled')); return }
    let server: Server | null = null
    let settled = false
    let aborted = false
    const cleanup = (): void => {
      try {
        server?.close()
        server?.closeAllConnections?.()
      } catch {
        // Already closing.
      }
    }

    const onAbort = (): void => {
      aborted = true
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Login cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const tryPort = (index: number): void => {
      if (aborted) return
      if (index >= options.ports.length) {
        options.signal?.removeEventListener('abort', onAbort)
        if (!settled) { settled = true; reject(new Error(options.ports.length === 1 && options.ports[0] !== 0
          ? 'Sign-in needs localhost port ' + options.ports[0] + '. Close the other sign-in or app using that port and retry.'
          : 'No free callback port was available')) }
        return
      }
      const port = options.ports[index]
      const attempt = createServer((req, res) => {
        const headers = { 'connection': 'close', 'cache-control': 'no-store' }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, headers).end()
          return
        }
        if (!isLoopbackHost(req.headers.host)) {
          res.writeHead(400, headers).end('Invalid host')
          return
        }
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== options.path) {
          res.writeHead(404, headers).end()
          return
        }
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const error = url.searchParams.get('error')
        if (!code && error === null) { res.writeHead(400, headers).end('Missing authorization code'); return }
        if (settled) { res.writeHead(409, headers).end(); return }
        settled = true
        if (error !== null) {
          res.writeHead(400, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(ERROR_HTML)
        } else {
          res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
        }
        options.signal?.removeEventListener('abort', onAbort)
        setImmediate(cleanup)
        resolve(error === null ? { code, state } : { code, state, error })
      })

      attempt.once('error', () => {
        attempt.close()
        tryPort(index + 1)
      })
      attempt.listen(port, '127.0.0.1', () => {
        if (aborted) {
          attempt.close()
          attempt.closeAllConnections?.()
          return
        }
        server = attempt
        const bound = (attempt.address() as AddressInfo).port
        options.onListening?.(bound)
      })
    }

    tryPort(0)
  })
}