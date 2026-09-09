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
  useEffect(() => {
    return window.anticode.onSessionCreated((spec) => {
      const store = useSessionStore.getState()
      store.addExternalSession(spec)
      void window.anticode.getSessionSnapshot(spec.sessionId).then((messages) => {
        if (messages !== null) store.importSnapshot(spec.sessionId, messages)
      })
    })
  }, [])

  useEffect(() => {
    return window.anticode.onAgentEvent((event) => {
      const store = useSessionStore.getState()
      const run = store.activeRun
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
            store.settleMessage(run.messageId)
            store.setActiveRun(null)
            break
          case 'end':
            if (event.reason !== 'complete') {
              store.appendText(run.sessionId, run.messageId, `\n[${event.reason}]`)
            }
            store.settleMessage(run.messageId)
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
          store.appendText(
            event.sessionId,
            store.mirrorStart(event.runId, event.sessionId),
            `\n${event.message}`
          )
          store.mirrorSettle(event.runId)
          void window.anticode.getSessionSnapshot(event.sessionId).then((messages) => {
            if (messages !== null) useSessionStore.getState().importSnapshot(event.sessionId, messages)
          })
          break
        }
        case 'end':
          store.mirrorSettle(event.runId)
          void window.anticode.getSessionSnapshot(event.sessionId).then((messages) => {
            if (messages !== null) useSessionStore.getState().importSnapshot(event.sessionId, messages)
          })
          break
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
