import { useCallback, useEffect, useState, useRef } from 'react'
import type { JSX } from 'react'
import { TabBar } from './components/TabBar'
import { SessionView } from './components/SessionView'
import { NewSessionView } from './components/NewSessionView'
import { Composer } from './components/Composer'
import { SettingsView } from './components/SettingsView'
import { CONTINUE_PROMPT, RESUME_LABEL } from './components/Composer'
import { ApprovalModal } from './components/ApprovalModal'
import { useSessionStore } from './store/session'
import type {
  AppInfo,
  ApprovalDecision,
  ApprovalRequest,
  ProviderId,
  ProviderInfo,
  SessionStatus
} from '@shared/ipc'

type View = 'dashboard' | 'session' | 'settings'

export function App(): JSX.Element {
  const finishedRuns = useRef(new Set<string>())
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
    void window.anticode.createSession({
      sessionId,
      mode: 'code',
      workspaceRoot: null
    })
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
      for (const old of store.sessions) if (!specs.some((spec) => spec.sessionId === old.id)) store.deleteSession(old.id)
      for (const spec of specs) {
        store.addExternalSession(spec)
        const messages = await window.anticode.getSessionSnapshot(spec.sessionId)
        if (active && messages !== null && !sessionBusy(spec.sessionId)) store.importSnapshot(spec.sessionId, messages)
      }
      for (const run of await window.anticode.listRuns()) {
        if (active && !finishedRuns.current.has(run.runId) && !useSessionStore.getState().activeRuns[run.runId]) store.mirrorStart(run.runId, run.sessionId)
      }
    }).catch((error: Error) => setAppError(error.message))
    const refresh = () => { void window.anticode.getStatus().then(setStatus).catch((error: Error) => setAppError(error.message)) }
    const timer = window.setInterval(refresh, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    return window.anticode.onApprovalRequest((request) => {
      setApprovals((queue) => [...queue, request])
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
      void window.anticode.getSessionSnapshot(spec.sessionId).then((messages) => {
        if (messages !== null && !sessionBusy(spec.sessionId)) useSessionStore.getState().importSnapshot(spec.sessionId, messages)
      })
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
    return window.anticode.onAgentEvent((event) => {
      if (event.type === 'end' || event.type === 'error') {
        finishedRuns.current.add(event.runId)
        setApprovals((queue) => queue.filter((request) => request.runId !== event.runId))
      }
      const store = useSessionStore.getState()
      const run = store.activeRuns[event.runId]
      /** Model label for the closing summary card. */
      const modelOf = (sessionId: string): string =>
        store.sessions.find((session) => session.id === sessionId)?.model ?? ''
      const summaryOf = (sessionId: string, startedAt: number) => ({
        model: modelOf(sessionId),
        durationMs: Date.now() - startedAt
      })

      if (run !== undefined) {
        switch (event.type) {
          case 'prompt':
            break
          case 'text_delta':
            store.appendText(run.sessionId, run.messageId, event.text)
            break
          case 'tool_start':
            store.startTool(run.sessionId, run.messageId, event.toolUseId, event.name, event.input)
            break
          case 'tool_end':
            store.endTool(run.sessionId, run.messageId, event.toolUseId, event.ok, event.output)
            break
          case 'usage':
            store.addUsage(run.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens)
            break
          case 'error':
            store.appendText(run.sessionId, run.messageId, `\n${event.message}`)
            store.settleMessage(run.messageId, summaryOf(run.sessionId, run.startedAt))
            store.setActiveRun(null, event.runId)
            break
          case 'end': {
            const pausedNow = useSessionStore.getState().pausedSessions[run.sessionId] === true
            // A deliberate pause is not a failure — no [cancelled] scar.
            if (event.reason !== 'complete' && !(event.reason === 'cancelled' && pausedNow)) {
              store.appendText(run.sessionId, run.messageId, `\n[${event.reason}]`)
            }
            store.settleMessage(run.messageId, summaryOf(run.sessionId, run.startedAt))
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
            store.endTool(event.sessionId, messageId, event.toolUseId, event.ok, event.output)
          }
          break
        }
        case 'usage':
          store.addUsage(event.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens)
          break
        case 'error': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const summary =
            entry !== undefined ? summaryOf(event.sessionId, entry.startedAt) : undefined
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
            entry !== undefined ? summaryOf(event.sessionId, entry.startedAt) : undefined
          store.mirrorSettle(event.runId, summary)

          break
        }
      }
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

  const selectProvider = useCallback((provider: ProviderId, model: string) => {
    void window.anticode
      .selectProvider({ provider, model })
      .then(setStatus)
      .then(() => window.anticode.listModels(provider))
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
        <>
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
        </>
      )}
    </div>
  )
}
