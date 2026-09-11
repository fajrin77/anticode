import { BrowserWindow, Notification } from 'electron'
import type { NotificationKind } from '@shared/ipc'
import { preferences } from './preferences'
import { focusSession, showMainWindow } from './windows'

/*
 * Every system notification goes through here, so Settings → General decides
 * them all in one place: which kinds may show, whether they make a sound, and
 * whether they wait for anticode to be in the background. Clicking one opens
 * the session it is about.
 */

/**
 * Shown notifications, held until clicked or closed: macOS drops the click
 * handler of one that has been garbage collected.
 */
const shown = new Set<Notification>()

export function notify(kind: NotificationKind, message: { title: string; body: string; sessionId?: string | null }): void {
  const settings = preferences().notifications
  if (!settings.enabled || !settings[kind]) return
  if (settings.background && BrowserWindow.getFocusedWindow() !== null) return
  const supported = (Notification as typeof Notification | undefined)?.isSupported
  if (supported?.() !== true) return
  const notification = new Notification({ title: message.title, body: message.body, silent: !settings.sound })
  shown.add(notification)
  const forget = (): void => { shown.delete(notification) }
  notification.on('click', () => {
    forget()
    if (message.sessionId !== undefined && message.sessionId !== null) focusSession(message.sessionId)
    else showMainWindow()
  })
  notification.on('close', forget)
  notification.show()
}
