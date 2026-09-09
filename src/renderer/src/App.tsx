import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { TabBar } from './components/TabBar'
import { SessionView } from './components/SessionView'
import { NewSessionView } from './components/NewSessionView'
import { Composer } from './components/Composer'
import { SettingsView } from './components/SettingsView'
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
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [view, setView] = useState<View>('dashboard')
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
    return window.anticode.onApprovalRequest((request) => {
      setApprovals((queue) => [...queue, request])
    })
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
        if (messages !== null) useSessionStore.getState().importSnapshot(spec.sessionId, messages)
      })
    })
  }, [])

  // A phone-initiated delete removes the tab here too; a run it owned is
  // cancelled first so it does not keep streaming into a dead session.
  useEffect(() => {
    return window.anticode.onSessionClosed((sessionId) => {
      const store = useSessionStore.getState()
      const run = store.activeRun
      if (run !== null && run.sessionId === sessionId) {
        void window.anticode.cancelRun(run.runId)
        store.setActiveRun(null)
      }
      store.deleteSession(sessionId)
    })
  }, [])

  /** A snapshot import must never race a live run on the same session — it
   * would wipe the streamed transcript and the just-typed prompt. */
  const sessionBusy = (sessionId: string): boolean => {
    const state = useSessionStore.getState()
    if (state.activeRun?.sessionId === sessionId) return true
    return Object.values(state.mirrorRuns).some((entry) => entry.sessionId === sessionId)
  }

  const importWhenQuiet = (
    sessionId: string,
    summary?: { model: string; durationMs: number }
  ): void => {
    if (sessionBusy(sessionId)) return
    void window.anticode.getSessionSnapshot(sessionId).then((messages) => {
      if (messages !== null) useSessionStore.getState().importSnapshot(sessionId, messages)
      if (summary !== undefined) {
        useSessionStore.getState().stampLastSummary(sessionId, summary)
      }
    })
  }

  useEffect(() => {
    return window.anticode.onAgentEvent((event) => {
      const store = useSessionStore.getState()
      const run = store.activeRun
      /** Model label for the closing summary card. */
      const modelOf = (sessionId: string): string =>
        store.sessions.find((session) => session.id === sessionId)?.model ?? ''
      const summaryOf = (sessionId: string, startedAt: number) => ({
        model: modelOf(sessionId),
        durationMs: Date.now() - startedAt
      })

      if (run !== null && run.runId === event.runId) {
        switch (event.type) {
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
            store.setActiveRun(null)
            break
          case 'end':
            if (event.reason !== 'complete') {
              store.appendText(run.sessionId, run.messageId, `\n[${event.reason}]`)
            }
            store.settleMessage(run.messageId, summaryOf(run.sessionId, run.startedAt))
            store.setActiveRun(null)
            break
        }
        return
      }

      // A run started elsewhere (the phone): mirror it live into its session,
      // then pull the finished transcript so nothing is lost in translation.
      switch (event.type) {
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
          importWhenQuiet(event.sessionId, summary)
          break
        }
        case 'end': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const summary =
            entry !== undefined ? summaryOf(event.sessionId, entry.startedAt) : undefined
          store.mirrorSettle(event.runId, summary)
          importWhenQuiet(event.sessionId, summary)
          break
        }
      }
    })
  }, [])

  // With no session left the dashboard is the view — it creates nothing on
  // its own; a session only comes into existence via "+" or a first prompt.
  useEffect(() => {
    if (activeSessionId === null) {
      setView('dashboard')
    } else {
      setView('session')
    }
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
      <TabBar
        onDashboard={() => setView('dashboard')}
        onOpenSettings={() =>
          setView((current) => (current === 'settings' ? 'session' : 'settings'))
        }
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
          onBack={() => setView(activeSessionId === null ? 'dashboard' : 'session')}
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
              {pending && (
                <ApprovalModal
                  key={pending.requestId}
                  request={pending}
                  onDecide={(decision) => decide(pending.requestId, decision)}
                />
              )}
              <Composer
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
