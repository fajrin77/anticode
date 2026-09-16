import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useSessionStore } from '../store/session'
import type { ScheduleEntry, ScheduleInput, SessionMode } from '@shared/ipc'

interface ScheduleViewProps {
  onBack: () => void
  onOpenSession: (id: string) => void
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** "8:00 AM" — the row's clock, matching the modal's Time field. */
function clockLabel(hour: number, minute: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}:${pad(minute)} ${suffix}`
}

/** "Daily · 8:00 AM" or "Weekly · Monday · 8:00 AM". */
function cadence(entry: ScheduleEntry): string {
  if (entry.frequency === 'weekly') {
    const day = WEEKDAYS[entry.weekday ?? 0]
    return `Weekly · ${day} · ${clockLabel(entry.hour, entry.minute)}`
  }
  return `Daily · ${clockLabel(entry.hour, entry.minute)}`
}

/** "in 3h", "in 2d", or "—" when a schedule is paused. */
function untilLabel(at: number | null): string {
  if (at === null) return '—'
  const delta = at - Date.now()
  if (delta <= 0) return 'due'
  const minutes = Math.round(delta / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

/** The modal's draft — one shape whether adding or editing. */
interface Draft {
  name: string
  frequency: 'daily' | 'weekly'
  weekday: number
  hour: number
  minute: number
  prompt: string
  sessionId: string
  enabled: boolean
  /** When true, the main process builds a fresh session from mode + folder. */
  newSession: boolean
  mode: SessionMode
  folder: string
}

function draftFrom(entry: ScheduleEntry): Draft {
  return {
    name: entry.name,
    frequency: entry.frequency,
    weekday: entry.weekday ?? 1,
    hour: entry.hour,
    minute: entry.minute,
    prompt: entry.prompt,
    sessionId: entry.sessionId,
    enabled: entry.enabled,
    newSession: false,
    mode: 'chat',
    folder: ''
  }
}

/** The editor. The session it fires into carries the model, so the modal
 * offers a session picker instead of a provider/model pair of its own. */
function ScheduleModal({
  entry,
  onClose,
  onSaved
}: {
  entry: ScheduleEntry | null
  onClose: () => void
  onSaved: (saved: ScheduleEntry) => void
}): JSX.Element {
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const usable = useMemo(
    () => sessions.filter((session) => session.messages.length > 0),
    [sessions]
  )
  const fallback = activeSessionId ?? usable[0]?.id ?? ''
  const [draft, setDraft] = useState<Draft>(
    entry !== null
      ? draftFrom(entry)
      : {
          name: '',
          frequency: 'daily',
          weekday: 1,
          hour: 9,
          minute: 0,
          prompt: '',
          sessionId: fallback,
          enabled: true,
          newSession: usable.length === 0,
          mode: 'chat',
          folder: ''
        }
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function update(patch: Partial<Draft>): void {
    setDraft((current) => ({ ...current, ...patch }))
  }

  async function pickFolder(): Promise<void> {
    const status = await window.anticode.chooseWorkspace()
    if (status.workspaceRoot !== null) update({ folder: status.workspaceRoot })
  }

  async function save(): Promise<void> {
    if (saving) return
    if (draft.prompt.trim() === '') {
      setError('Give the schedule a prompt.')
      return
    }
    if (draft.newSession) {
      if (draft.mode === 'code' && draft.folder.trim() === '') {
        setError('Pick a folder for the new anticode session.')
        return
      }
    } else if (draft.sessionId === '') {
      setError('Pick a session to run in.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (entry !== null) {
        const saved = await window.anticode.updateSchedule(entry.id, {
          name: draft.name.trim() || 'Scheduled run',
          prompt: draft.prompt.trim(),
          frequency: draft.frequency,
          hour: draft.hour,
          minute: draft.minute,
          ...(draft.frequency === 'weekly' ? { weekday: draft.weekday } : {}),
          enabled: draft.enabled
        })
        onSaved(saved)
      } else {
        const input: ScheduleInput = {
          name: draft.name.trim() || 'Scheduled run',
          prompt: draft.prompt.trim(),
          frequency: draft.frequency,
          hour: draft.hour,
          minute: draft.minute,
          ...(draft.frequency === 'weekly' ? { weekday: draft.weekday } : {}),
          ...(draft.newSession
            ? {
                sessionId: '',
                newSession: true,
                mode: draft.mode,
                workspaceRoot: draft.mode === 'code' ? draft.folder : null
              }
            : { sessionId: draft.sessionId })
        }
        const saved = await window.anticode.addSchedule(input)
        onSaved(saved)
      }
      onClose()
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={entry !== null ? 'Edit schedule' : 'New schedule'}
        className="glass-surface flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-line-soft px-6 py-4">
          <div>
            <h2 className="text-[16px] text-text">{entry !== null ? 'Edit schedule' : 'Schedule'}</h2>
            <p className="mt-0.5 text-[12.5px] text-dim">Create a scheduler routine.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-dim transition-colors hover:text-brand"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <label className="mb-1.5 block text-[12.5px] text-dim">Name</label>
          <input
            value={draft.name}
            onChange={(event) => update({ name: event.target.value })}
            placeholder="Daily code review"
            className="glass-field mb-4 w-full rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none placeholder:text-faint focus:border-hover"
          />

          <label className="mb-1.5 block text-[12.5px] text-dim">Schedule</label>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <select
              value={draft.frequency}
              onChange={(event) => update({ frequency: event.target.value as 'daily' | 'weekly' })}
              className="glass-field rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none focus:border-hover"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            {draft.frequency === 'weekly' ? (
              <select
                value={draft.weekday}
                onChange={(event) => update({ weekday: Number(event.target.value) })}
                className="glass-field rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none focus:border-hover"
              >
                {WEEKDAYS.map((day, index) => (
                  <option key={day} value={index}>{day}</option>
                ))}
              </select>
            ) : (
              <div className="glass-field flex items-center rounded-lg border border-line px-3 py-2 text-[13.5px] text-faint">
                Every day
              </div>
            )}
            <input
              type="time"
              value={`${pad(draft.hour)}:${pad(draft.minute)}`}
              onChange={(event) => {
                const [h, m] = event.target.value.split(':')
                update({ hour: Number(h), minute: Number(m) })
              }}
              className="glass-field rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none focus:border-hover"
            />
          </div>

          <label className="mb-1.5 block text-[12.5px] text-dim">Prompt</label>
          <textarea
            value={draft.prompt}
            onChange={(event) => update({ prompt: event.target.value })}
            rows={4}
            placeholder="Review PRs opened yesterday and summarize issues."
            className="glass-field mb-4 w-full resize-none rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none placeholder:text-faint focus:border-hover"
          />

          <label className="mb-1.5 block text-[12.5px] text-dim">Run in</label>
          {entry === null ? (
            <div className="mb-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => update({ newSession: false })}
                className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                  draft.newSession
                    ? 'border-line text-dim hover:text-brand'
                    : 'border-brand text-brand'
                }`}
              >
                Existing session
              </button>
              <button
                type="button"
                onClick={() => update({ newSession: true })}
                className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                  draft.newSession
                    ? 'border-brand text-brand'
                    : 'border-line text-dim hover:text-brand'
                }`}
              >
                New session
              </button>
            </div>
          ) : null}

          {draft.newSession && entry === null ? (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => update({ mode: 'chat' })}
                  className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                    draft.mode === 'chat'
                      ? 'border-brand text-brand'
                      : 'border-line text-dim hover:text-brand'
                  }`}
                >
                  antichat
                </button>
                <button
                  type="button"
                  onClick={() => update({ mode: 'code' })}
                  className={`rounded-lg border px-3 py-2 text-[13px] transition-colors ${
                    draft.mode === 'code'
                      ? 'border-brand text-brand'
                      : 'border-line text-dim hover:text-brand'
                  }`}
                >
                  anticode
                </button>
              </div>
              {draft.mode === 'code' && (
                <button
                  type="button"
                  onClick={() => void pickFolder()}
                  className="mb-3 flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-[13px] transition-colors hover:text-brand"
                >
                  <span className="text-dim transition-colors">Folder</span>
                  <span className={`min-w-0 flex-1 truncate ${draft.folder === '' ? 'text-faint' : 'text-text'}`}>
                    {draft.folder === '' ? 'Pick a folder…' : draft.folder}
                  </span>
                </button>
              )}
              <p className="mb-4 text-[12px] text-faint">
                A fresh {draft.mode === 'code' ? 'anticode' : 'antichat'} session is created when the
                schedule is saved. Every run gets a new empty conversation in this folder.
              </p>
            </>
          ) : (
            <>
              <select
                value={draft.sessionId}
                onChange={(event) => update({ sessionId: event.target.value })}
                disabled={entry !== null}
                className="glass-field mb-1 w-full rounded-lg border border-line px-3 py-2 text-[13.5px] text-text outline-none focus:border-hover disabled:opacity-60"
              >
                {usable.length === 0 && <option value="">No sessions yet</option>}
                {usable.map((session) => (
                  <option key={session.id} value={session.id}>{session.title}</option>
                ))}
              </select>
              <p className="mb-4 text-[12px] text-faint">
                The run uses this session's model and folder — nothing to pick again.
              </p>
            </>
          )}

          {error !== null && <div role="alert" className="mb-2 text-[12.5px] text-del">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-[13.5px] text-dim transition-colors hover:text-brand"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-lg bg-brand px-4 py-2 text-[13.5px] font-medium text-bg transition-colors hover:bg-brand-strong disabled:opacity-60"
          >
            {entry !== null ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The Schedule page: recurring prompts, one session each. The desktop and the
 * phone share the same entries; this screen adds, edits, pauses and removes
 * them, and shows when each one next fires.
 */
export function ScheduleView({ onBack, onOpenSession }: ScheduleViewProps): JSX.Element {
  const [entries, setEntries] = useState<ScheduleEntry[]>([])
  const [editing, setEditing] = useState<ScheduleEntry | null | 'new'>(null)

  useEffect(() => {
    let live = true
    void window.anticode.listSchedules().then((list) => { if (live) setEntries(list) }).catch(() => undefined)
    const off = window.anticode.onScheduleState((list) => setEntries(list))
    return () => {
      live = false
      off()
    }
  }, [])

  function apply(saved: ScheduleEntry): void {
    setEntries((current) => {
      const next = current.filter((item) => item.id !== saved.id)
      next.push(saved)
      return next.sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity))
    })
  }

  async function toggle(entry: ScheduleEntry): Promise<void> {
    const saved = await window.anticode.updateSchedule(entry.id, { enabled: !entry.enabled })
    apply(saved)
  }

  async function remove(entry: ScheduleEntry): Promise<void> {
    await window.anticode.removeSchedule(entry.id)
    setEntries((current) => current.filter((item) => item.id !== entry.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-10 pt-8 pb-5">
        <div>
          <h1 className="text-[19px] text-text">Schedule</h1>
          <p className="mt-1 max-w-lg text-[13px] text-dim">
            Run agents on cron schedules for recurring automations like daily summaries and code reviews.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg px-3 py-2 text-[13.5px] text-dim transition-colors hover:text-brand"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="rounded-lg border border-line px-4 py-2 text-[13.5px] text-text transition-colors hover:text-brand"
          >
            + New Schedule
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-10">
        {entries.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md text-center text-[14px] text-dim">
            No schedules yet. Create one to run a prompt on a daily or weekly clock.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="glass-surface rounded-xl border border-line px-5 py-4"
              >
                <div className="flex items-center gap-3">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${entry.enabled ? 'bg-brand' : 'bg-faint'}`} />
                  <button
                    type="button"
                    onClick={() => onOpenSession(entry.sessionId)}
                    className="min-w-0 flex-1 truncate text-left text-[14.5px] text-text transition-colors hover:text-brand"
                  >
                    {entry.name}
                  </button>
                  <span className="glass-ghost shrink-0 rounded-full border border-line px-2.5 py-0.5 text-[12px] text-dim">
                    {cadence(entry)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void toggle(entry)}
                    title={entry.enabled ? 'Pause' : 'Resume'}
                    className="shrink-0 text-dim transition-colors hover:text-brand"
                  >
                    {entry.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(entry)}
                    title="Edit"
                    className="shrink-0 text-dim transition-colors hover:text-brand"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(entry)}
                    title="Delete"
                    className="shrink-0 text-dim transition-colors hover:text-del"
                  >
                    Delete
                  </button>
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12.5px] text-dim">{entry.prompt}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
                  <span>Last run: {entry.lastRunAt !== null ? new Date(entry.lastRunAt).toLocaleString() : '—'}</span>
                  <span>Result: {entry.lastError ?? entry.lastResult ?? '—'}</span>
                  <span>Next run: {untilLabel(entry.nextRunAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing !== null && (
        <ScheduleModal
          entry={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={apply}
        />
      )}
    </div>
  )
}