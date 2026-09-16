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

/**
 * Waits for one OAuth redirect. The promise resolves with the parsed query,
 * or rejects when the signal aborts or the caller's port list is exhausted.
 */
export function waitForCallback(options: LocalServerOptions): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let server: Server | null = null
    const cleanup = (): void => {
      try {
        server?.close()
      } catch {
        // Already closing.
      }
    }

    const onAbort = (): void => {
      cleanup()
      reject(new Error('Login cancelled'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const tryPort = (index: number): void => {
      if (index >= options.ports.length) {
        options.signal?.removeEventListener('abort', onAbort)
        reject(new Error('No free callback port was available'))
        return
      }
      const port = options.ports[index]
      const attempt = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        if (url.pathname !== options.path) {
          res.writeHead(404).end()
          return
        }
        const code = url.searchParams.get('code') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const error = url.searchParams.get('error')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
        options.signal?.removeEventListener('abort', onAbort)
        setImmediate(cleanup)
        resolve(error === null ? { code, state } : { code, state, error })
      })

      attempt.once('error', () => {
        attempt.close()
        tryPort(index + 1)
      })
      attempt.listen(port, '127.0.0.1', () => {
        server = attempt
        const bound = (attempt.address() as AddressInfo).port
        options.onListening?.(bound)
      })
    }

    tryPort(0)
  })
}