import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { TabBar } from './components/TabBar'
import { HomeView } from './components/HomeView'
import { SessionView } from './components/SessionView'
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
  SessionMode,
  SessionStatus
} from '@shared/ipc'

type View = 'home' | 'session' | 'settings'

export function App(): JSX.Element {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [view, setView] = useState<View>('home')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  // Read at click time so a session binds the folder shown when it was started.
  const currentRoot = useRef<string | null>(null)

  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const addProject = useSessionStore((state) => state.addProject)
  const openSession = useSessionStore((state) => state.openSession)

  const startSession = useCallback(
    (mode: SessionMode) => {
      const root = useSessionStore.getState().projects.length > 0 ? currentRoot.current : null
      if (mode === 'code' && root === null) return
      const sessionId = openSession(mode, mode === 'code' ? root : null)
      void window.anticode.createSession({
        sessionId,
        mode,
        workspaceRoot: mode === 'code' ? root : null
      })
    },
    [openSession]
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
      currentRoot.current = sessionStatus.workspaceRoot
      if (sessionStatus.workspaceRoot !== null) addProject(sessionStatus.workspaceRoot)

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
  }, [addProject])

  useEffect(() => {
    return window.anticode.onApprovalRequest((request) => {
      setApprovals((queue) => [...queue, request])
    })
  }, [])

  useEffect(() => {
    return window.anticode.onAgentEvent((event) => {
      const store = useSessionStore.getState()
      const run = store.activeRun
      if (!run || run.runId !== event.runId) return

      switch (event.type) {
        case 'text_delta':
          store.appendText(run.messageId, event.text)
          break
        case 'tool_start':
          store.startTool(run.messageId, event.toolUseId, event.name, event.input)
          break
        case 'tool_end':
          store.endTool(run.messageId, event.toolUseId, event.ok, event.output)
          break
        case 'usage':
          store.addUsage(event.provider, event.model, event.inputTokens, event.outputTokens)
          break
        case 'error':
          store.appendText(run.messageId, `\n${event.message}`)
          store.settleMessage(run.messageId)
          store.setActiveRun(null)
          break
        case 'end':
          if (event.reason !== 'complete') store.appendText(run.messageId, `\n[${event.reason}]`)
          store.settleMessage(run.messageId)
          store.setActiveRun(null)
          break
      }
    })
  }, [])

  // Selecting a session in the tab bar or home list is what reveals the session view.
  useEffect(() => {
    if (activeSessionId !== null) setView('session')
  }, [activeSessionId])

  const decide = useCallback((requestId: string, decision: ApprovalDecision) => {
    setApprovals((queue) => queue.filter((request) => request.requestId !== requestId))
    void window.anticode.respondToApproval({ requestId, decision }).then(() => {
      if (decision === 'always') void window.anticode.getStatus().then(setStatus)
    })
  }, [])

  const addProjectFolder = useCallback(() => {
    void window.anticode.chooseWorkspace().then((next) => {
      setStatus(next)
      currentRoot.current = next.workspaceRoot
      if (next.workspaceRoot !== null) addProject(next.workspaceRoot)
    })
  }, [addProject])

  const selectProject = useCallback((root: string) => {
    void window.anticode.setWorkspace(root).then((next) => {
      setStatus(next)
      currentRoot.current = next.workspaceRoot
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

  return (
    <div className="flex h-full flex-col">
      <TabBar
        homeActive={view !== 'session'}
        onHome={() => setView('home')}
        onNewTab={() => startSession('chat')}
      />

      {view === 'home' && (
        <HomeView
          activeProjectRoot={status?.workspaceRoot ?? null}
          onAddProject={addProjectFolder}
          onSelectProject={selectProject}
          onOpenSettings={() => setView('settings')}
          onStart={startSession}
        />
      )}

      {view === 'settings' && (
        <SettingsView
          appInfo={appInfo}
          status={status}
          providers={providers}
          onSelectProvider={selectProvider}
          onBack={() => setView('home')}
        />
      )}

      {view === 'session' && (
        <>
          <SessionView />
          <Composer
            status={status}
            providers={providers}
            onSelectProvider={selectProvider}
            onToggleAutoApprove={toggleAutoApprove}
          />
        </>
      )}

      {pending && (
        <ApprovalModal
          key={pending.requestId}
          request={pending}
          onDecide={(decision) => decide(pending.requestId, decision)}
        />
      )}
    </div>
  )
}
