import { resolve } from 'node:path'
import { cpSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** The remote UI ships as static files next to the compiled main process. */
const copyRemoteUi: Plugin = {
  name: 'anticode:copy-remote-ui',
  apply: 'build',
  closeBundle() {
    cpSync(resolve('src/main/remote/public'), resolve('out/main/remote/public'), {
      recursive: true
    })
  }
}

/**
 * Injected on build only: the dev server needs inline scripts for React Refresh.
 * `connect-src 'self'` is deliberate — provider network calls belong in the main
 * process, so the renderer should never reach the network directly.
 */
const contentSecurityPolicy: Plugin = {
  name: 'anticode:csp',
  apply: 'build',
  transformIndexHtml(html) {
    const policy = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'"
    ].join('; ')
    return html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
    )
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyRemoteUi],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy]
  }
})
