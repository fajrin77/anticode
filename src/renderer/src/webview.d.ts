import type { DetailedHTMLProps, HTMLAttributes } from 'react'

/**
 * Electron's <webview> — the browser pane's guest — is not in React's element
 * table, and its own typings live in the `electron` package, which the
 * renderer deliberately does not import. This is the shape the pane uses.
 */
export interface WebviewElement extends HTMLElement {
  src: string
  getURL: () => string
  getTitle: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  loadURL: (url: string) => Promise<void>
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
      }
    }
  }
}
