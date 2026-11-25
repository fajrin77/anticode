import { useCallback, useEffect, useState, useRef } from 'react'
import type { JSX } from 'react'
import { restoreDraftAttachments, DASHBOARD_DRAFT } from './draftAttachments'
import { useSessionSwipe } from './hooks/useSessionSwipe'
import { SessionSidebar } from './components/SessionSidebar'
import { TabBar } from './components/TabBar'
import { SessionPicker } from './components/SessionPicker'
import { latestReply, neighbourSession, openComposerMenu, sessionOrder } from './shortcuts'
import { SessionView } from './components/SessionView'
import { NewSessionView } from './components/NewSessionView'
import { Composer } from './components/Composer'
import { SettingsView, requestSettingsSection } from './components/SettingsView'
import { ScheduleView } from './components/ScheduleView'
import { CONTINUE_PROMPT, PAUSE_LABEL, RESUME_LABEL } from './components/Composer'
import { ApprovalModal } from './components/ApprovalModal'
import { QuestionModal } from './components/QuestionModal'
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
  QuestionAnswer,
  QuestionRequest,
  RoutedAgentEvent,
  SessionStatus,
  UpdateState
} from '@shared/ipc'
import { ROTATE_PROVIDER, statusFor } from '@shared/ipc'

type View = 'dashboard' | 'session' | 'settings' | 'schedule'

export function App(): JSX.Element {
  useEffect(() => { void restoreDraftAttachments() }, [])
  const hydrating = useRef(true)
  const bufferedEvents = useRef<RoutedAgentEvent[]>([])
  const receiveEvent = useRef<(event: RoutedAgentEvent) => void>(() => undefined)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [status, setStatusRaw] = useState<SessionStatus | null>(null)
  // The 5 s poll returns a new object even when nothing changed; keeping the
  // old one spares a full re-render of the app every poll.
  const setStatus = useCallback((next: SessionStatus | null) => {
    if (next !== null && useSessionStore.getState().followUpMode !== next.followUpMode) {
      useSessionStore.setState({ followUpMode: next.followUpMode })
    }
    setStatusRaw((previous) => previous !== null && next !== null && JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }, [])
  const statusRef = useRef(status)
  statusRef.current = status
  const focusTimer = useRef<number | undefined>(undefined)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [appError, setAppError] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  // A version the user closed the banner on; the next one appears on its own.
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarPreview, setSidebarPreview] = useState(false)
  const sidebarCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const keepSidebarPreview = useCallback(() => {
    clearTimeout(sidebarCloseTimer.current)
    setSidebarPreview(true)
  }, [])
  const hideSidebarPreview = useCallback(() => {
    clearTimeout(sidebarCloseTimer.current)
    // Allow crossing the small gap between the header button and the panel.
    sidebarCloseTimer.current = setTimeout(() => setSidebarPreview(false), 180)
  }, [])
  const toggleSidebar = useCallback(() => {
    clearTimeout(sidebarCloseTimer.current)
    setSidebarPreview(false)
    setSidebarOpen((open) => !open)
  }, [])
  useEffect(() => () => clearTimeout(sidebarCloseTimer.current), [])
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('anticode.collapsedProjects') ?? '[]')
      return new Set(Array.isArray(saved) ? saved.filter((root): root is string => typeof root === 'string') : [])
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('anticode.collapsedProjects', JSON.stringify([...collapsedProjects]))
    } catch (error) {
      console.warn('Could not save collapsed project preferences', error)
    }
  }, [collapsedProjects])
  const [view, setView] = useState<View>('dashboard')
  // Where Settings was opened from, so closing it returns there. Without this
  // the gear dropped the user into a session view that may not exist.
  const viewBeforeSettings = useRef<View>('dashboard')
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [questions, setQuestions] = useState<QuestionRequest[]>([])

  // The updater checks on its own; this is where the window says so, so the
  // user does not have to open Settings and press Check now.
  useEffect(() => {
    void window.anticode.getUpdateState().then(setUpdateState)
    return window.anticode.onUpdateState(setUpdateState)
  }, [])

  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const openSession = useSessionStore((state) => state.openSession)
  const reopenSession = useSessionStore((state) => state.reopenSession)

  const showDashboard = useCallback(() => {
    const state = useSessionStore.getState()
    const status = statusRef.current
    const own = status === null ? null : statusFor(status, state.activeSessionId)
    // The dashboard is a composer for the *next* session, so a plus pressed
    // inside a session keeps that session's project folder: the new one starts
    // in the same workspace instead of asking again. Only from a session — a
    // folder picked on the dashboard itself must survive a second visit.
    const source = view === 'session'
      ? state.sessions.find((session) => session.id === state.activeSessionId)
      : undefined
    state.updateDraft(DASHBOARD_DRAFT, {
      ...(own === null ? {} : { selection: { provider: own.provider, model: own.model } }),
      ...(source === undefined ? {} : { mode: source.mode, folder: source.projectRoot })
    })
    setView('dashboard')
  }, [view])

  const startSameProject = useCallback(async (id: string) => {
    const source = useSessionStore.getState().sessions.find((session) => session.id === id)
    if (!source) return
    const choice = status === null ? source : statusFor(status, source.id)
    const sessionId = openSession(source.mode, source.projectRoot, choice.provider, choice.model)
    try {
      if (choice.provider && choice.model !== null) setStatus(await window.anticode.selectProvider({ provider: choice.provider, model: choice.model ?? '' }, sessionId))
      setView('session')
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error))
    }
  }, [openSession, status])

  // Selecting the already-active session changes no store state, so
  // the effect below never fires, the view switch happens here explicitly.
  // Reopening a saved session also clears its archived state.
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
      if (info.storageWarning !== null) setAppError(info.storageWarning)
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
      // Recovery flag (set by the error boundary after repeat crashes): list
      // sessions but skip replaying their transcripts, so a poisoned message
      // can never take the window down twice in a row. Clearing the flag is a
      // plain restart without the hash.
      const recovery = window.location.hash === '#recover'
      if (recovery) {
        hydrating.current = false
        history.replaceState(null, '', window.location.pathname)
        return
      }
      for (const old of store.sessions) if (!specs.some((spec) => spec.sessionId === old.id)) store.deleteSession(old.id)
      // Snapshots arrive at their own pace: four concurrent restores keep a
      // heavy archive from serialising startup while capping IPC pressure.
      // Each session still stands on its own, one poisoned snapshot must not
      // abort the whole restore or leave the app half-hydrated.
      const queue = [...specs]
      const restoreOne = async (): Promise<void> => {
        while (active) {
          const spec = queue.shift()
          if (spec === undefined) return
          try {
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
          } catch (error) {
            console.error(`[anticode] restore failed for session ${spec.sessionId}:`, error)
          }
        }
      }
      await Promise.all([restoreOne(), restoreOne(), restoreOne(), restoreOne()])
      if (!active) return
      hydrating.current = false
      const pending = bufferedEvents.current.splice(0)
      for (const event of pending) {
        try {
          if ((event.revision ?? Infinity) > (revisions.get(event.sessionId) ?? 0)) receiveEvent.current(event)
        } catch (error) {
          console.error('[anticode] buffered event dropped:', error)
        }
      }
    }).catch((error: Error) => {
      hydrating.current = false
      for (const event of bufferedEvents.current.splice(0)) {
        try {
          receiveEvent.current(event)
        } catch (eventError) {
          console.error('[anticode] buffered event dropped after hydrate failure:', eventError)
        }
      }
      setAppError(error.message)
    })
    const refresh = () => {
      if (document.hidden) return
      void window.anticode.getStatus().then(setStatus).catch((error: Error) => setAppError(error.message))
    }
    const timer = window.setInterval(refresh, 5000)
    const onVisibility = () => { if (!document.hidden) refresh() }
    document.addEventListener('visibilitychange', onVisibility)
    // A model picked on the phone shows here the moment it is picked.
    const unsubscribe = window.anticode.onStatus(setStatus)
    // So does a provider added or removed there.
    const unsubscribeProviders = window.anticode.onProviders(setProviders)
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility); unsubscribe(); unsubscribeProviders() }
  }, [])

  // The agent's questions wait for a clicked answer the same way approvals
  // wait for a decision; answering from the phone removes the card here too.
  useEffect(() => {
    return window.anticode.onQuestionRequest((request) => {
      setQuestions((queue) => [...queue, request])
    })
  }, [])

  useEffect(() => {
    const unsubscribe = window.anticode.onQuestionDismissed((id) => setQuestions((queue) => queue.filter((request) => request.requestId !== id)))
    void window.anticode.pendingQuestions().then((pending) => setQuestions((queue) => [...queue, ...pending.filter((request) => !queue.some((entry) => entry.requestId === request.requestId))]))
    return unsubscribe
  }, [])

  // The browser panes are owned by the main process, the agent opens pages,
  // and the phone has to see the same ones, so the renderer only mirrors them.
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
    // Only the latest request waits: a newer click replaces an older retry.
    const unsubscribe = window.anticode.onSessionFocus((sessionId) => {
      window.clearTimeout(focusTimer.current)
      const open = (attempt: number): void => {
        const store = useSessionStore.getState()
        if (store.sessions.some((session) => session.id === sessionId)) {
          openExistingSession(sessionId)
        } else if (attempt < 20) {
          focusTimer.current = window.setTimeout(() => open(attempt + 1), 100)
        }
      }
      open(0)
    })
    return () => { window.clearTimeout(focusTimer.current); unsubscribe() }
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
    let active = true
    let dismissed: Set<string> | undefined = new Set()
    const remove = window.anticode.onApprovalDismissed(id => {
      dismissed?.add(id)
      setApprovals(queue => queue.filter(request => request.requestId !== id))
    })
    const add = window.anticode.onApprovalRequest(request => {
      setApprovals(queue => queue.some(entry => entry.requestId === request.requestId) ? queue : [...queue, request])
    })
    void window.anticode.pendingApprovals().then(pending => {
      if (!active) return
      const visible = pending.filter(request => !dismissed?.has(request.requestId))
      setApprovals(queue => [...queue, ...visible.filter(request => !queue.some(entry => entry.requestId === request.requestId))])
    }).catch(error => { if (active) setAppError(String(error)) }).finally(() => { dismissed = undefined })
    return () => { active = false; add(); remove() }
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
  // was typed, the phone included.
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
      // Every run of it, local or mirrored: a steer can sit beside the main one.
      for (const [runId, entry] of [...Object.entries(store.activeRuns), ...Object.entries(store.mirrorRuns)]) {
        if (entry.sessionId !== sessionId) continue
        void window.anticode.cancelRun(runId)
        store.setActiveRun(null, runId)
      }
      store.deleteSession(sessionId)
    })
  }, [])

  /** A snapshot import must never race a live run on the same session, it
   * would wipe the streamed transcript and the just-typed prompt. */
  const sessionBusy = (sessionId: string): boolean => {
    const state = useSessionStore.getState()
    if (Object.values(state.activeRuns).some((run) => run.sessionId === sessionId)) return true
    return Object.values(state.mirrorRuns).some((entry) => entry.sessionId === sessionId)
  }

  useEffect(() => {
    // Tokens arrive far faster than the screen redraws. They are gathered per
    // message and written once a frame, so a long transcript re-renders at
    // display rate instead of once per token. Any other event writes what was
    // gathered first, which keeps text and tool steps in their real order.
    const gathered = new Map<string, { sessionId: string; messageId: string; text: string }>()
    let frame: number | null = null
    let timer: number | null = null
    const writeGathered = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      if (timer !== null) window.clearTimeout(timer)
      frame = null
      timer = null
      if (gathered.size === 0) return
      const items = [...gathered.values()]
      gathered.clear()
      const store = useSessionStore.getState()
      for (const item of items) store.appendText(item.sessionId, item.messageId, item.text)
    }
    const gather = (sessionId: string, messageId: string, text: string): void => {
      const key = `${sessionId}\0${messageId}`
      const item = gathered.get(key)
      if (item !== undefined) item.text += text
      else gathered.set(key, { sessionId, messageId, text })
      if (frame !== null || timer !== null) return
      // A hidden window gets no animation frames; a short timer keeps it current.
      if (document.hidden) timer = window.setTimeout(writeGathered, 200)
      else frame = requestAnimationFrame(writeGathered)
    }
    receiveEvent.current = (event) => {
      if (event.type !== 'text_delta') writeGathered()
      if (event.type === 'end' || event.type === 'error') {
        setApprovals((queue) => queue.filter((request) => request.runId !== event.runId))
      }
      const store = useSessionStore.getState()
      // A session that is only archived, not deleted, has to come back the
      // moment new work starts there, otherwise work started on the phone lands
      // in a tab nobody can see. Only on a new prompt: surfacing on every token
      // made a tab closed mid-stream reopen itself at once.
      if (event.type === 'prompt' || event.type === 'steer') store.surfaceSession(event.sessionId)
      const run = store.activeRuns[event.runId]
      /** Model label for the closing summary card. */
      const modelOf = (sessionId: string): string =>
        store.sessions.find((session) => session.id === sessionId)?.model ?? ''
      const summaryOf = (
        sessionId: string,
        startedAt: number,
        tokens?: { inputTokens?: number; outputTokens?: number; model?: string }
      ) => ({
        // The model that served the run, not whatever the session moved to since.
        model: tokens?.model ?? modelOf(sessionId),
        durationMs: Date.now() - startedAt,
        inputTokens: tokens?.inputTokens ?? 0,
        outputTokens: tokens?.outputTokens ?? 0
      })

      if (run !== undefined) {
        switch (event.type) {
          case 'prompt':
            if (event.model !== undefined) {
              store.setRunModel(run.sessionId, event.provider ?? '', event.model)
            }
            break
          case 'steer':
            store.steerRun(event.runId, run.sessionId, event.text, event.attachments)
            break
          case 'steer_taken':
            store.takeSteer(event.runId, run.sessionId)
            break
          case 'text_delta':
            gather(run.sessionId, run.messageId, event.text)
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
          case 'summary':
            store.summaryInRun(run.sessionId, run.messageId, event.text)
            break
          case 'phase':
            // The dot's vocabulary between replies: Thinking, Browsing, ...
            store.setRunPhase(event.runId, event.phase)
            break
          case 'tool_end':
            store.endTool(run.sessionId, run.messageId, event.toolUseId, event.ok, event.output, event.diff)
            break
          case 'usage':
            store.addUsage(run.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens, `${event.runId}:${event.revision}`, event.subagent, event.costUsd)
            store.addRunTokens(event.runId, event.inputTokens, event.outputTokens)
            break
          case 'error':
            if (event.retryable === true) store.pauseSession(run.sessionId)
            store.errorInRun(run.sessionId, run.messageId, event.message)
            store.settleMessage(run.messageId, event.summary ?? summaryOf(run.sessionId, run.startedAt, useSessionStore.getState().activeRuns[event.runId]))
            store.setActiveRun(null, event.runId)
            break
          case 'end': {
            const pausedNow = useSessionStore.getState().pausedSessions[run.sessionId] === true
            // A deliberate pause is not a failure, no [cancelled] scar.
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
          if (event.model !== undefined) {
            store.setRunModel(event.sessionId, event.provider ?? '', event.model)
          }
          break
        case 'steer':
          // A follow-up to a run this window only watches, from the phone,
          // or joined before this window caught the run's start.
          store.mirrorStart(event.runId, event.sessionId)
          store.steerRun(event.runId, event.sessionId, event.text, event.attachments)
          break
        case 'steer_taken':
          store.mirrorStart(event.runId, event.sessionId)
          store.takeSteer(event.runId, event.sessionId)
          break
        case 'text_delta':
          gather(event.sessionId, store.mirrorStart(event.runId, event.sessionId), event.text)
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
        case 'summary':
          store.summaryInRun(event.sessionId, store.mirrorStart(event.runId, event.sessionId), event.text)
          break
        case 'phase':
          store.setRunPhase(event.runId, event.phase)
          break
        case 'usage':
          store.addUsage(event.sessionId, event.provider, event.model, event.inputTokens, event.outputTokens, `${event.runId}:${event.revision}`, event.subagent, event.costUsd)
          store.addRunTokens(event.runId, event.inputTokens, event.outputTokens)
          break
        case 'error': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const summary =
            event.summary ?? (entry !== undefined ? summaryOf(event.sessionId, entry.startedAt, entry) : undefined)
          if (event.retryable === true) store.pauseSession(event.sessionId)
          store.errorInRun(event.sessionId, store.mirrorStart(event.runId, event.sessionId), event.message)
          store.mirrorSettle(event.runId, summary)

          break
        }
        case 'end': {
          const entry = useSessionStore.getState().mirrorRuns[event.runId]
          const pausedNow = useSessionStore.getState().pausedSessions[event.sessionId] === true
          if (entry !== undefined && event.reason !== 'complete' && !(event.reason === 'cancelled' && pausedNow)) {
            store.appendText(event.sessionId, entry.messageId, `\n[${event.reason}]`)
          }
          const summary =
            event.summary ?? (entry !== undefined ? summaryOf(event.sessionId, entry.startedAt, entry) : undefined)
          store.mirrorSettle(event.runId, summary)

          break
        }
      }
    }
    const unsubscribe = window.anticode.onAgentEvent((event) => {
      if (hydrating.current) bufferedEvents.current.push(event)
      else receiveEvent.current(event)
    })
    return () => { unsubscribe(); writeGathered() }
  }, [])

  // With no session left the dashboard is the view, it creates nothing on
  // its own; a session only comes into existence via "+" or a first prompt.
  // A session appearing or vanishing (the phone can do either) must not yank
  // the user out of Settings mid-edit.
  useEffect(() => {
    setView((current) =>
      current === 'settings' || current === 'schedule' ? current : activeSessionId === null ? 'dashboard' : 'session'
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

  const [picker, setPicker] = useState(false)
  const [search, setSearch] = useState(0)
  const [terminal, setTerminal] = useState(0)
  const [copiedReply, setCopiedReply] = useState(false)

  // Tabs closed in this window, newest last, for Mod+Shift+T.
  const closedTabs = useRef<string[]>([])
  useEffect(() => useSessionStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    const was = new Map(previous.sessions.map((session) => [session.id, session.closed]))
    for (const session of state.sessions) {
      if (session.closed && was.get(session.id) === false) closedTabs.current = [...closedTabs.current.filter((id) => id !== session.id), session.id].slice(-20)
    }
  }), [])

  const openSettings = useCallback(() => {
    setView((current) => {
      if (current === 'settings') return current
      viewBeforeSettings.current = current
      return 'settings'
    })
  }, [])

  useEffect(() => {
    if (!copiedReply) return
    const timer = window.setTimeout(() => setCopiedReply(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copiedReply])

  // The list in Settings → Shortcuts (shortcuts.ts) documents every key handled here.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      const mod = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      const state = useSessionStore.getState()
      const id = state.activeSessionId
      const go = (step: 1 | -1): void => {
        const next = neighbourSession(sessionOrder(state), view === 'session' ? id : null, step)
        if (next !== null) openExistingSession(next)
      }
      // Ctrl+Tab moves between sessions on every platform, like browser tabs.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === 'Tab') {
        event.preventDefault()
        go(event.shiftKey ? -1 : 1)
        return
      }
      if (event.altKey || (!mod && key !== 'escape')) return
      if (key === 'escape' || (mod && !event.shiftKey && key === '.')) {
        if (event.shiftKey || picker || view !== 'session' || id === null || event.repeat) return
        if (key === 'escape' && document.querySelector('[data-transcript-search], [data-image-viewer], .menu-glass:not([popover]), :popover-open, [data-approval], [data-question]')) return
        if (![...Object.values(state.activeRuns), ...Object.values(state.mirrorRuns)].some(run => run.sessionId === id)) return
        event.preventDefault()
        void window.anticode.pauseSession(id).catch(error => setAppError(String(error)))
        return
      }
      if (event.shiftKey) {
        // Shifted keys are matched by their physical key, which holds on any keyboard layout.
        const code = event.code
        if (code === 'BracketRight') go(1)
        else if (code === 'BracketLeft') go(-1)
        else if (code === 'KeyT') {
          const reopen = [...closedTabs.current].reverse().find((closed) => state.sessions.some((session) => session.id === closed && session.closed))
          if (reopen === undefined) return
          closedTabs.current = closedTabs.current.filter((closed) => closed !== reopen)
          openExistingSession(reopen)
        } else if (code === 'KeyM' && view !== 'settings' && view !== 'schedule') openComposerMenu('model')
        else if (code === 'KeyE' && view !== 'settings' && view !== 'schedule') openComposerMenu('effort')
        else if (code === 'KeyC' && view === 'session') {
          // Mod+Shift+C with text selected is left to the system's own copy.
          if (window.getSelection()?.toString()) return
          const reply = latestReply(state.sessions.find((session) => session.id === id))
          if (reply === '') return
          void navigator.clipboard.writeText(reply).then(() => setCopiedReply(true)).catch(error => setAppError(String(error)))
        } else return
        event.preventDefault()
        return
      }
      if (key === 'n') showDashboard()
      else if (key === 'b') toggleSidebar()
      else if (key === ',') toggleSettings()
      else if (key === '/') { requestSettingsSection('shortcuts'); openSettings() }
      else if (key === 'f' && view === 'session') setSearch(value => value + 1)
      else if (key === 'j' && view === 'session') setTerminal(value => value + 1)
      else if (key === 'l' && (view === 'session' || view === 'dashboard')) {
        const box = document.querySelector<HTMLTextAreaElement>('main textarea')
        if (box === null) return
        box.focus()
        box.setSelectionRange(box.value.length, box.value.length)
      }
      else if (key === 'k') setPicker(value => !value)
      else if (key === 'w' && view === 'session' && id !== null) state.closeSession(id)
      else if (/^[1-9]$/.test(key)) {
        const session = sessionOrder(state)[Number(key) - 1]
        if (session === undefined) return
        openExistingSession(session.id)
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openExistingSession, openSettings, picker, showDashboard, toggleSettings, toggleSidebar, view])

  const decide = useCallback((request: ApprovalRequest, decision: ApprovalDecision) => {
    void window.anticode.respondToApproval({ requestId: request.requestId, sessionId: request.sessionId, decision }).then(() => {
      if (decision === 'always') void window.anticode.getStatus().then(setStatus)
    }).catch(error => setAppError(String(error)))
  }, [])

  const answerQuestion = useCallback((requestId: string, answer: Omit<QuestionAnswer, 'requestId'>) => {
    setQuestions((queue) => queue.filter((request) => request.requestId !== requestId))
    void window.anticode.respondToQuestion({ ...answer, requestId })
  }, [])

  // With a session id only that session changes model; the pick also becomes
  // what new sessions start on. Settings and the dashboard pass none.
  const selectProvider = useCallback((provider: ProviderId, model: string, sessionId?: string | null) => {
    void window.anticode
      .selectProvider({ provider, model }, sessionId ?? null)
      .then(setStatus)
      .then(() =>
        provider === ROTATE_PROVIDER || model !== ''
          ? undefined
          : window.anticode.listModels(provider).then(() => window.anticode.getStatus()).then(setStatus)
      )
      .catch((error: Error) => setAppError(error.message))
  }, [])

  const toggleAutoApprove = useCallback((enabled: boolean) => {
    void window.anticode.setAutoApprove(enabled).then(setStatus)
  }, [])

  // Popups belong to a session screen, never to Settings or the dashboard.
  const onSession = view === 'session'
  const pending = onSession ? approvals.find(request => request.sessionId === activeSessionId) : undefined
  // A question belongs to the session that asked it; other tabs stay clean.
  const pendingQuestion = onSession ? questions.find((request) => request.sessionId === activeSessionId) : undefined
  // Only an empty session is needed here; a streaming one must not re-render App per token.
  const activeSession = useSessionStore((state) => {
    const session = state.sessions.find((entry) => entry.id === state.activeSessionId)
    return session !== undefined && session.messages.length === 0 ? session : undefined
  })
  const isFreshSession = activeSession !== undefined
  const web = useWebSession(activeSessionId)
  const swipeRoot = useSessionSwipe(view === 'session' && pending === undefined && pendingQuestion === undefined, openExistingSession)

  // An update the user has not closed the banner on. Ready means it has been
  // downloaded and waits for a restart; available means it waits for the click.
  const availableVersion =
    updateState !== null && (updateState.status === 'available' || updateState.status === 'ready')
      ? updateState.latest
      : null
  const showUpdateBanner = availableVersion !== null && availableVersion !== dismissedVersion

  return (
    <div ref={swipeRoot} className="session-swipe-root flex h-full flex-col overflow-hidden">
      {showUpdateBanner && availableVersion !== null && (
        <div
          role="status"
          // On macOS the hidden-inset title bar puts the window buttons at the top left; keep the text clear of them.
          className={`flex items-center justify-between gap-4 bg-raised py-2 pr-6 text-[13px] text-text ${/Mac/i.test(navigator.userAgent) ? 'pl-24' : 'pl-6'}`}
        >
          <span className="min-w-0 flex-1">
            {updateState?.status === 'ready'
              ? `anticode ${availableVersion} is downloaded and ready to install.`
              : `anticode ${availableVersion} is available.`}
          </span>
          <button
            type="button"
            onClick={() => {
              viewBeforeSettings.current = view
              setView('settings')
            }}
            className="shrink-0 rounded-md px-2 py-0.5 text-dim transition-colors hover:bg-hover hover:text-brand"
          >
            Open Settings
          </button>
          <button
            type="button"
            onClick={() => setDismissedVersion(availableVersion)}
            className="shrink-0 rounded-md px-2 py-0.5 text-dim transition-colors hover:bg-hover hover:text-brand"
          >
            Dismiss
          </button>
        </div>
      )}
      <FileViewer />
      {picker && <SessionPicker onClose={() => setPicker(false)} onSelect={openExistingSession} />}
      <TabBar
        waitingForApproval={approvals.some(request => request.sessionId !== activeSessionId) ? () => {
          const first = approvals.find(request => request.sessionId !== activeSessionId)
          if (first) openExistingSession(first.sessionId)
        } : undefined}
        dashboardActive={view === 'dashboard'}
        settingsActive={view === 'settings'}
        scheduleActive={view === 'schedule'}
        selectedProvider={status === null ? null : statusFor(status, activeSessionId).provider}
        selectedModel={status === null ? null : statusFor(status, activeSessionId).model}
        lastUsedProvider={status === null ? null : statusFor(status, activeSessionId).lastUsed?.provider ?? null}
        onDashboard={showDashboard}
        onOpenSettings={toggleSettings}
        onOpenSchedule={() => setView('schedule')}
        sidebarOpen={sidebarOpen || sidebarPreview}
        onToggleSidebar={toggleSidebar}
        onSidebarPointerEnter={keepSidebarPreview}
        onSidebarPointerLeave={hideSidebarPreview}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {(sidebarOpen || sidebarPreview) && <div
          onPointerEnter={keepSidebarPreview}
          onPointerLeave={hideSidebarPreview}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !sidebarOpen && !event.nativeEvent.isComposing) {
              event.preventDefault()
              setSidebarPreview(false)
              document.querySelector<HTMLButtonElement>('[aria-controls="session-sidebar"]')?.focus()
            }
          }}
          className={sidebarOpen ? 'flex shrink-0' : 'absolute inset-y-0 left-0 z-30 flex shadow-xl'}
        ><SessionSidebar
          preview={!sidebarOpen}
          approvalSessions={new Set(approvals.map(request => request.sessionId))}
          collapsed={collapsedProjects}
          onToggleProject={(root) => setCollapsedProjects((current) => {
            const next = new Set(current)
            if (next.has(root)) next.delete(root)
            else next.add(root)
            return next
          })}
          active={view === 'session'}
          dashboardActive={view === 'dashboard'}
          onDashboard={showDashboard}
          onSelectSession={openExistingSession}
          onNewSession={startSameProject}
        /></div>}
        <main className="@container flex min-w-0 flex-1 flex-col overflow-hidden">
      {copiedReply && (
        <div role="status" className="glass-surface pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-text shadow-lg">
          Latest reply copied
        </div>
      )}
      {appError && (
        <div
          role="alert"
          className="flex max-h-[25vh] shrink-0 items-start justify-between gap-4 overflow-y-auto bg-raised px-6 py-2 text-[13px] text-del"
        >
          <span className="min-w-0 flex-1 select-text whitespace-pre-wrap [overflow-wrap:anywhere]">{appError}</span>
          <button
            type="button"
            onClick={() => setAppError(null)}
            className="shrink-0 rounded-md px-2 py-0.5 text-dim transition-colors hover:bg-hover hover:text-brand"
          >
            Dismiss
          </button>
        </div>
      )}

      {view === 'schedule' && (
        <ScheduleView onBack={() => setView('dashboard')} onOpenSession={openExistingSession} />
      )}

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
        <DropZone sessionId={DASHBOARD_DRAFT}><NewSessionView
          session={undefined}
          status={status}
          providers={providers}
          onSelectProvider={selectProvider}
          onToggleAutoApprove={toggleAutoApprove}
          onSelectSession={openExistingSession}
          onOpenSchedule={() => setView('schedule')}
        /></DropZone>
      )}

      {view === 'session' && (
        // The transcript gives up the right-hand side to the browser pane
        // rather than being covered by it: both stay usable at once, which is
        // the point of watching a page the agent is working on.
        <div className="relative flex min-h-0 min-w-0 w-full flex-1 overflow-hidden">
          {/* Full size hands the whole window to the page. The transcript is
              only set aside, not unmounted, its scroll and draft are where
              they were when the pane shrinks back. */}
          <div
            data-session-swipe
            data-session-slide
            className={`@container flex min-w-0 flex-1 flex-col ${
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
                  onOpenSchedule={() => setView('schedule')}
                />
              ) : (
                <>
                  <SessionView searchPulse={search} terminalPulse={terminal} />
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
        </main>
      </div>
      {pending && <ApprovalModal key={pending.requestId} request={pending} sessionTitle={useSessionStore.getState().sessions.find(session => session.id === pending.sessionId)?.title} onDecide={(decision) => decide(pending, decision)} />}
      {pending === undefined && pendingQuestion !== undefined && <QuestionModal key={pendingQuestion.requestId} request={pendingQuestion} onAnswer={(answer) => answerQuestion(pendingQuestion.requestId, answer)} />}
    </div>
  )
}
