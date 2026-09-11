import { useCallback, useEffect, useState, useRef } from 'react'
import type { JSX } from 'react'
import { TabBar } from './components/TabBar'
import { SessionView } from './components/SessionView'
import { NewSessionView } from './components/NewSessionView'
import { Composer } from './components/Composer'
import { SettingsView } from './components/SettingsView'
import { CONTINUE_PROMPT, PAUSE_LABEL, RESUME_LABEL } from './components/Composer'
import { ApprovalModal } from './components/ApprovalModal'
import { useSessionStore } from './store/session'
import { useWebSession, useWebStore } from './store/web'
import { WebPanel } from './components/WebPanel'
import { FileViewer } from './components/FileViewer'
import { usePreviewStore } from './store/preview'
import { DropZone } from './components/DropZone'
import type {
  AppInfo,
  ApprovalDecision,
  ApprovalRequest,
  ProviderId,
  ProviderInfo,
  RoutedAgentEvent,
  SessionStatus
} from '@shared/ipc'
import { ROTATE_PROVIDER } from '@shared/ipc'

type View = 'dashboard' | 'session' | 'settings'

export function App(): JSX.Element {
  const hydrating = useRef(true)
  const bufferedEvents = useRef<RoutedAgentEvent[]>([])
  const receiveEvent = useRef<(event: RoutedAgentEvent) => void>(() => undefined)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [appError, setAppError] = useState<string | null>(null)
  const [view, setView] = useState<View>('dashboard')
  // Where Settings was opened from, so closing it returns there. Without this
  // the gear dropped the user into a session view that may not exist.
  const viewBeforeSettings = useRef<View>('dashboard')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])

  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const openSession = useSessionStore((state) => state.openSession)
  const reopenSession = useSessionStore((state) => state.reopenSession)

  // New sessions start as anticode drafts; the mode and folder are chosen in
  // the dashboard and only bound to the main-process session on first send.
  const startSession = useCallback(() => {
    const sessionId = openSession('code', null)
    // The colour this window just painted is offered to the main process,
    // which owns colours so the phone paints the session the same; whatever it
    // settles on is what both show.
    const colour = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId)?.colour
    void window.anticode
      .createSession({
        sessionId,
        mode: 'code',
        workspaceRoot: null,
        ...(colour !== undefined ? { colour } : {})
      })
      .then((settled) => useSessionStore.getState().addExternalSession(settled))
  }, [openSession])

  // Cmd/Ctrl+N mints a fresh session, exactly like the "+" tab.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        startSession()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [startSession])

  // Clicking the tab of the already-active session changes no store state, so
  // the effect below never fires — the view switch happens here explicitly.
  // Reopening from the dashboard also un-archives the session's tab.
  const openExistingSession = useCallback(
    (id: string) => {
      reopenSession(id)
      setView('session')
    },
    [reopenSession]
  )

  useEffect(() => {
    let active = true
    void Promise.all([
      window.anticode.getAppInfo(),
      window.anticode.getStatus(),
      window.anticode.listProviders()
    ]).then(([info, sessionStatus, providerList]) => {
      if (!active) return
      setAppInfo(info)
      setStatus(sessionStatus)
      setProviders(providerList)

      // Discovering the catalogue also fills an empty model, so a fresh key is
      // usable without anyone typing an id.
      if (sessionStatus.provider === ROTATE_PROVIDER) return
      void window.anticode
        .listModels(sessionStatus.provider)
        .then(() => window.anticode.getStatus())
        .then((refreshed) => {
          if (active) setStatus(refreshed)
        })
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.anticode.listSessions().then(async (specs) => {
      if (!active) return
      const store = useSessionStore.getState()
      const revisions = new Map<string, number>()
      for (const old of store.sessions) if (!specs.some((spec) => spec.sessionId === old.id)) store.deleteSession(old.id)
      for (const spec of specs) {
        store.addExternalSession(spec)
        // Saved before the main process kept colours: hand over the one this
        // window has been showing, so the phone matches it from now on.
        if (spec.colour === undefined) {
          const shown = useSessionStore.getState().sessions.find((entry) => entry.id === spec.sessionId)?.colour
          if (shown !== undefined) void window.anticode.setSessionColour(spec.sessionId, shown)
        }
        const snapshot = await window.anticode.getSessionSnapshot(spec.sessionId)
        if (active && snapshot !== null) {
          store.importSnapshot(spec.sessionId, snapshot.messages, snapshot.summaries)
          revisions.set(spec.sessionId, snapshot.revision)
          for (const event of snapshot.events) receiveEvent.current(event)
          if (snapshot.paused) store.pauseSession(spec.sessionId)
          else store.resumeSession(spec.sessionId)
          store.setQueue(spec.sessionId, snapshot.queue ?? [])
        }
      }
      if (!active) return
      hydrating.current = false
      const pending = bufferedEvents.current.splice(0)
      for (const event of pending) {
        if ((event.revision ?? Infinity) > (revisions.get(event.sessionId) ?? 0)) receiveEvent.current(event)
      }
    }).catch((error: Error) => {
      hydrating.current = false
      for (const event of bufferedEvents.current.splice(0)) receiveEvent.current(event)
      setAppError(error.message)
    })
    const refresh = () => { void window.anticode.getStatus().then(setStatus).catch((error: Error) => setAppError(error.message)) }
    const timer = window.setInterval(refresh, 5000)
    // A model picked on the phone shows here the moment it is picked.
    const unsubscribe = window.anticode.onStatus(setStatus)
    // So does a provider added or removed there.
    const unsubscribeProviders = window.anticode.onProviders(setProviders)
    return () => { active = false; window.clearInterval(timer); unsubscribe(); unsubscribeProviders() }
  }, [])

  useEffect(() => {
    return window.anticode.onApprovalRequest((request) => {
      setApprovals((queue) => [...queue, request])
    })
  }, [])

  // The browser panes are owned by the main process — the agent opens pages,
  // and the phone has to see the same ones — so the renderer only mirrors them.
  useEffect(() => {
    const setSessions = useWebStore.getState().setSessions
    void window.anticode.listWebSessions().then(setSessions)
    return window.anticode.onWebSessions(setSessions)
  }, [])

  // A pause is the main process's too: pressed here or on the phone, every
  // viewer shows it, and every viewer can resume it.
  useEffect(() => {
    const unsubscribe = window.anticode.onSessionPaused(({ sessionId, paused }) => {
      const store = useSessionStore.getState()
      if (paused) {
        store.pauseSession(sessionId)
        store.addNotice(sessionId, PAUSE_LABEL)
      } else {
        store.resumeSession(sessionId)
      }
    })
    void window.anticode.listPausedSessions().then((ids) => {
      const store = useSessionStore.getState()
      for (const id of Object.keys(store.pausedSessions)) {
        if (!ids.includes(id)) store.resumeSession(id)
      }
      for (const id of ids) store.pauseSession(id)
    })
    return unsubscribe
  }, [])

  // The queue is the main process's: a prompt queued on the phone shows here,
  // and one sent or taken out anywhere leaves every list.
  useEffect(() => {
    return window.anticode.onSessionQueue(({ sessionId, items }) => {
      useSessionStore.getState().setQueue(sessionId, items)
    })
  }, [])

  // The tray, a quick capture, or a clicked notification asks for a session:
  // it comes back if it was archived, and the view goes to it. A session
  // created a moment ago may not have reached this window yet, so it waits.
  useEffect(() => {
    return window.anticode.onSessionFocus((sessionId) => {
      const open = (attempt: number): void => {
        const store = useSessionStore.getState()
        if (store.sessions.some((session) => session.id === sessionId)) {
          openExistingSession(sessionId)
        } else if (attempt < 20) {
          window.setTimeout(() => open(attempt + 1), 100)
        }
      }
      open(0)
    })
  }, [openExistingSession])

  // A turn reverted from the phone is gone from the real history; the
  // transcript here is redrawn from it rather than keep showing the exchange.
  useEffect(() => {
    return window.anticode.onSessionHistory((sessionId) => {
      if (sessionBusy(sessionId)) return
      void window.anticode.getSessionSnapshot(sessionId).then((snapshot) => {
        if (snapshot !== null && !sessionBusy(sessionId)) {
          useSessionStore.getState().importSnapshot(sessionId, snapshot.messages, snapshot.summaries)
        }
      })
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.anticode.onApprovalDismissed((id) => setApprovals((queue) => queue.filter((request) => request.requestId !== id)))
    void window.anticode.pendingApprovals().then((pending) => setApprovals((queue) => [...queue, ...pending.filter((request) => !queue.some((entry) => entry.requestId === request.requestId))]))
    return unsubscribe
  }, [])

  // Sessions created on the phone land in the desktop immediately, with their
  // main-process transcript imported so the conversation is readable here.
  // A session the desktop already owns is skipped: importing its (still nearly
  // empty) main-process snapshot would wipe the live, streaming transcript.
  useEffect(() => {
    return window.anticode.onSessionCreated((spec) => {
      const store = useSessionStore.getState()
      const known = store.sessions.some((session) => session.id === spec.sessionId)
      store.addExternalSession(spec)
      if (known) return
      void window.anticode.getSessionSnapshot(spec.sessionId).then((snapshot) => {
        if (snapshot !== null && !sessionBusy(spec.sessionId)) {
          useSessionStore.getState().importSnapshot(spec.sessionId, snapshot.messages, snapshot.summaries)
        }
      })
    })
  }, [])

  // A preview belongs to the screen it was opened from; going to another
  // session or view puts it away.
  useEffect(() => {
    usePreviewStore.getState().close()
  }, [activeSessionId, view])

  // Names come from the main process, wherever the prompt that earned one
  // was typed — the phone included.
  useEffect(() => {
    return window.anticode.onSessionTitle(({ sessionId, title }) => {
      useSessionStore.getState().setSessionTitle(sessionId, title)
    })
  }, [])

  // A phone-initiated delete removes the tab here too; a run it owned is
  // cancelled first so it does not keep streaming into a dead session.
  useEffect(() => {
    return window.anticode.onSessionClosed((sessionId) => {
      const store = useSessionStore.getState()
      const run = Object.values(store.activeRuns).find((entry) => entry.sessionId === sessionId)
      if (run !== undefined) {
        void window.anticode.cancelRun(run.runId)
        store.setActiveRun(null, run.runId)
      }
      store.deleteSession(sessionId)
    })
  }, [])

  /** A snapshot import must never race a live run on the same session — it
   * would wipe the streamed transcript and the just-typed prompt. */
  const sessionBusy = (sessionId: string): boolean => {
    const state = useSessionStore.getState()
    if (Object.values(state.activeRuns).some((run) => run.sessionId === sessionId)) return true
    return Object.values(state.mirrorRuns).some((entry) => entry.sessionId === sessionId)
  }

  useEffect(() => {
    receiveEvent.current = (event) => {
      if (event.type === 'end' || event.type === 'error') {
        setApprovals((queue) => queue.filter((request) => request.runId !== event.runId))
      }
      const store = useSessionStore.getState()
      // A session that is only archived, not deleted, has to come back the
      // moment it moves — otherwise work started on the phone lands in a tab
      // nobody can see, and the session reads as gone.
      store.surfaceSession(event.sessionId)
      const run = store.activeRuns[event.runId]
      /** Model label for the closing summary card. */
      const modelOf = (sessionId: string): string =>
        store.sessions.find((session) => session.id === sessionId)?.model ?? ''
      const summaryOf = (
        sessionId: string,
        startedAt: number,
        tokens?: { inputTokens?: number; outputTokens?: number }
      ) => ({
        model: modelOf(sessionId),
        durationMs: Date.now() - startedAt,
        inputTokens: tokens?.inputTokens ?? 0,
        outputTokens: tokens?.outputTokens ?? 0
      })

      if (run !== undefined) {
        switch (event.type) {
          case 'prompt':
            break
          case 'steer':
            store.steerRun(event.runId, run.sessionId, event.text, event.attachments)
            break
          case 'steer_taken':
            store.takeSteer(event.runId, run.sessionId)
            break
          case 'text_delta':
            store.appendText(run.sessionId, run.messageId, event.text)
            break
          case 'tool_start':
            store.startTool(run.sessionId, run.messageId, event.toolUseId, event.name, event.input)
            break
          case 'tool_progress':
            store.progressTool(run.sessionId, event.toolUseId, event.text)
            break
          case 'notice':
            store.noticeInRun(run.sessionId, run.messageId, event.text)
            break
          case 'tool_end':
            store.endTool(run.sessionId, run.messageId, event.toolUseId, event.ok, event.output, event.diff)
            break
          case 'usage':
            store.addUsage(run.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens, `${event.runId}:${event.revision}`, event.subagent)
            store.addRunTokens(event.runId, event.inputTokens, event.outputTokens)
            break
          case 'error':
            store.appendText(run.sessionId, run.messageId, `\n${event.message}`)
            store.settleMessage(run.messageId, event.summary ?? summaryOf(run.sessionId, run.startedAt, useSessionStore.getState().activeRuns[event.runId]))
            store.setActiveRun(null, event.runId)
            break
          case 'end': {
            const pausedNow = useSessionStore.getState().pausedSessions[run.sessionId] === true
            // A deliberate pause is not a failure — no [cancelled] scar.
            if (event.reason !== 'complete' && !(event.reason === 'cancelled' && pausedNow)) {
              store.appendText(run.sessionId, run.messageId, `\n[${event.reason}]`)
            }
            store.settleMessage(run.messageId, event.summary ?? summaryOf(run.sessionId, run.startedAt, useSessionStore.getState().activeRuns[event.runId]))
            store.setActiveRun(null, event.runId)
            break
          }
        }
        return
      }

      // A run started elsewhere (the phone): mirror it live into its session,
      // then pull the finished transcript so nothing is lost in translation.
      switch (event.type) {
        case 'prompt':
          // A resume from the phone carries the continuation paragraph. It is
          // the app resuming itself, not a prompt anyone typed, so it lands as
          // the same grey marker a local resume writes.
          if (event.text === CONTINUE_PROMPT) store.addNotice(event.sessionId, RESUME_LABEL)
          else store.addUserPrompt(event.sessionId, event.text, event.attachments)
          store.mirrorStart(event.runId, event.sessionId)
          break
        case 'steer':
          // A follow-up to a run this window only watches — from the phone,
          // or joined before this window caught the run's start.
          store.mirrorStart(event.runId, event.sessionId)
          store.steerRun(event.runId, event.sessionId, event.text, event.attachments)
          break
        case 'steer_taken':
          store.mirrorStart(event.runId, event.sessionId)
          store.takeSteer(event.runId, event.sessionId)
          break
        case 'text_delta':
          store.appendText(event.sessionId, store.mirrorStart(event.runId, event.sessionId), event.text)
          break
        case 'tool_start': {
          const messageId = store.mirrorStart(event.runId, event.sessionId)
          store.startTool(event.sessionId, messageId, event.toolUseId, event.name, event.input)
          break
        }
        case 'tool_end': {
          const messageId = useSessionStore.getState().mirrorRuns[event.runId]?.messageId
          if (messageId !== undefined) {
            store.endTool(event.sessionId, messageId, event.toolUseId, event.ok, event.output, event.diff)
          }
          break
        }
        case 'tool_progress':
          store.progressTool(event.sessionId, event.toolUseId, event.text)
          break
        case 'notice':
          store.noticeInRun(event.sessionId, store.mirrorStart(event.runId, event.sessionId), event.text)
          break
        case 'usage':
          store.addUsage(event.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens, `${event.runId}:${event.revision}`, event.subagent)
          store.addRunTokens(event.runId, event.inputTokens, event.outputTokens)
          break
        case 'error': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const summary =
            event.summary ?? (entry !== undefined ? summaryOf(event.sessionId, entry.startedAt, entry) : undefined)
          store.appendText(
            event.sessionId,
            store.mirrorStart(event.runId, event.sessionId),
            `\n${event.message}`
          )
          store.mirrorSettle(event.runId, summary)

          break
        }
        case 'end': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const summary =
            event.summary ?? (entry !== undefined ? summaryOf(event.sessionId, entry.startedAt, entry) : undefined)
          store.mirrorSettle(event.runId, summary)

          break
        }
      }
    }
    return window.anticode.onAgentEvent((event) => {
      if (hydrating.current) bufferedEvents.current.push(event)
      else receiveEvent.current(event)
    })
  }, [])

  // With no session left the dashboard is the view — it creates nothing on
  // its own; a session only comes into existence via "+" or a first prompt.
  // A session appearing or vanishing (the phone can do either) must not yank
  // the user out of Settings mid-edit.
  useEffect(() => {
    setView((current) =>
      current === 'settings' ? current : activeSessionId === null ? 'dashboard' : 'session'
    )
  }, [activeSessionId])

  // The remembered view is only reachable while a session backs it; otherwise
  // the dashboard is the honest destination.
  const closeSettings = useCallback(() => {
    const target = viewBeforeSettings.current
    setView(target === 'session' && activeSessionId === null ? 'dashboard' : target)
  }, [activeSessionId])

  const toggleSettings = useCallback(() => {
    setView((current) => {
      if (current === 'settings') {
        const target = viewBeforeSettings.current
        return target === 'session' && activeSessionId === null ? 'dashboard' : target
      }
      viewBeforeSettings.current = current
      return 'settings'
    })
  }, [activeSessionId])

  const decide = useCallback((requestId: string, decision: ApprovalDecision) => {
    setApprovals((queue) => queue.filter((request) => request.requestId !== requestId))
    void window.anticode.respondToApproval({ requestId, decision }).then(() => {
      if (decision === 'always') void window.anticode.getStatus().then(setStatus)
    })
  }, [])

  // With a session id only that session changes model; the pick also becomes
  // what new sessions start on. Settings and the dashboard pass none.
  const selectProvider = useCallback((provider: ProviderId, model: string, sessionId?: string | null) => {
    void window.anticode
      .selectProvider({ provider, model }, sessionId ?? null)
      .then(setStatus)
      .then(() => (provider === ROTATE_PROVIDER ? undefined : window.anticode.listModels(provider)))
      .then(() => window.anticode.getStatus())
      .then(setStatus)
      .catch((error: Error) => setAppError(error.message))
  }, [])

  const toggleAutoApprove = useCallback((enabled: boolean) => {
    void window.anticode.setAutoApprove(enabled).then(setStatus)
  }, [])

  const pending = approvals[0]
  const activeSession = useSessionStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionId)
  )
  const isFreshSession =
    activeSession !== undefined && activeSession.messages.length === 0
  const web = useWebSession(activeSessionId)

  return (
    <div className="flex h-full flex-col">
      {appError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-4 bg-raised px-6 py-2 text-[13px] text-del"
        >
          <span className="min-w-0 flex-1">{appError}</span>
          <button
            type="button"
            onClick={() => setAppError(null)}
            className="shrink-0 rounded-md px-2 py-0.5 text-dim transition-colors hover:bg-hover hover:text-brand"
          >
            Dismiss
          </button>
        </div>
      )}
      <FileViewer />
      {pending && <ApprovalModal key={pending.requestId} request={pending} onDecide={(decision) => decide(pending.requestId, decision)} />}
      <TabBar
        dashboardActive={view === 'dashboard'}
        settingsActive={view === 'settings'}
        onDashboard={() => setView('dashboard')}
        onOpenSettings={toggleSettings}
        onNewTab={startSession}
        onSelectSession={openExistingSession}
      />

      {view === 'settings' && (
        <SettingsView
          appInfo={appInfo}
          status={status}
          providers={providers}
          onSelectProvider={selectProvider}
          onToggleAutoApprove={toggleAutoApprove}
          onProvidersChange={setProviders}
          onBack={closeSettings}
        />
      )}

      {view === 'dashboard' && (
        <NewSessionView
          session={undefined}
          status={status}
          providers={providers}
          onSelectProvider={selectProvider}
          onToggleAutoApprove={toggleAutoApprove}
          onSelectSession={openExistingSession}
        />
      )}

      {view === 'session' && (
        // The transcript gives up the right-hand side to the browser pane
        // rather than being covered by it: both stay usable at once, which is
        // the point of watching a page the agent is working on.
        <div className="flex min-h-0 flex-1">
          {/* Full size hands the whole window to the page. The transcript is
              only set aside, not unmounted — its scroll and draft are where
              they were when the pane shrinks back. */}
          <div
            className={`flex min-w-0 flex-1 flex-col ${
              web !== undefined && web.full && !web.hidden ? 'hidden' : ''
            }`}
          >
            <DropZone key={activeSessionId ?? 'none'} sessionId={activeSessionId ?? ''}>
              {isFreshSession ? (
                <NewSessionView
                  session={activeSession}
                  status={status}
                  providers={providers}
                  onSelectProvider={selectProvider}
                  onToggleAutoApprove={toggleAutoApprove}
                  onSelectSession={openExistingSession}
                />
              ) : (
                <>
                  <SessionView />
                  <Composer
                    key={activeSessionId}
                    status={status}
                    providers={providers}
                    onSelectProvider={selectProvider}
                    onToggleAutoApprove={toggleAutoApprove}
                  />
                </>
              )}
            </DropZone>
          </div>
          {activeSessionId !== null && web !== undefined && (
            <WebPanel
              key={activeSessionId}
              sessionId={activeSessionId}
              entry={web}
              open={!web.hidden}
              onHide={() => void window.anticode.setWebVisible(activeSessionId, false)}
            />
          )}
        </div>
      )}
    </div>
  )
}
