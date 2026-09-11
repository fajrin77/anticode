import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { McpServerInput, McpServerStatus } from '@shared/ipc'
import { Toggle } from './controls'

function errorText(failure: unknown): string {
  return (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** `npx -y "@scope/pkg" --flag` → program and arguments, quotes respected. */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) parts.push(match[1] ?? match[2] ?? match[3] ?? '')
  return parts
}

/** `KEY=value` per line; a key with nothing after `=` keeps its saved value. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const pairs: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf(separator)
    if (at <= 0) continue
    pairs[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return pairs
}

const STATE_TEXT: Record<McpServerStatus['state'], string> = {
  off: 'off',
  connecting: 'connecting…',
  ready: 'connected',
  error: 'failed'
}

interface Draft {
  id?: string
  name: string
  transport: 'stdio' | 'http'
  command: string
  url: string
  env: string
  headers: string
  trust: boolean
  enabled: boolean
}

const EMPTY: Draft = { name: '', transport: 'stdio', command: '', url: '', env: '', headers: '', trust: false, enabled: true }

function draftOf(server: McpServerStatus): Draft {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: [server.command, ...server.args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' '),
    url: server.url,
    // Saved secrets are never shown; an empty value keeps them.
    env: server.envKeys.map((key) => `${key}=`).join('\n'),
    headers: server.headerKeys.map((key) => `${key}:`).join('\n'),
    trust: server.trust,
    enabled: server.enabled
  }
}

function inputOf(draft: Draft): McpServerInput {
  const [command = '', ...args] = splitCommand(draft.command)
  return {
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    name: draft.name,
    enabled: draft.enabled,
    transport: draft.transport,
    command,
    args,
    env: parsePairs(draft.env, '='),
    url: draft.url,
    headers: parsePairs(draft.headers, ':'),
    trust: draft.trust
  }
}

function Editor({ initial, onDone }: { initial: Draft; onDone: () => void }): JSX.Element {
  const [draft, setDraft] = useState<Draft>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }))
  const field = 'glass-field w-full rounded-lg border px-3 py-1.5 text-[12.5px] text-text outline-none placeholder:text-faint'

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await window.anticode.saveMcpServer(inputOf(draft))
      onDone()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-line-soft px-5 py-4">
      <div className="flex gap-2">
        <input value={draft.name} onChange={(event) => set({ name: event.target.value })} placeholder="Name — github, filesystem, …" className={field} />
        <div className="flex shrink-0 items-center gap-0.5">
          {(['stdio', 'http'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => set({ transport: option })}
              className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors hover:text-brand ${
                draft.transport === option ? 'glass-control text-text' : 'border-transparent text-dim'
              }`}
            >
              {option === 'stdio' ? 'Command' : 'URL'}
            </button>
          ))}
        </div>
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <input
            value={draft.command}
            onChange={(event) => set({ command: event.target.value })}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /Users/me/projects"
            spellCheck={false}
            className={`${field} font-mono`}
          />
          <textarea
            value={draft.env}
            onChange={(event) => set({ env: event.target.value })}
            placeholder={'Environment, one per line: GITHUB_TOKEN=ghp_…'}
            rows={2}
            spellCheck={false}
            className={`${field} resize-none font-mono`}
          />
        </>
      ) : (
        <>
          <input
            value={draft.url}
            onChange={(event) => set({ url: event.target.value })}
            placeholder="https://mcp.example.com/mcp"
            spellCheck={false}
            className={`${field} font-mono`}
          />
          <textarea
            value={draft.headers}
            onChange={(event) => set({ headers: event.target.value })}
            placeholder={'Headers, one per line: Authorization: Bearer …'}
            rows={2}
            spellCheck={false}
            className={`${field} resize-none font-mono`}
          />
        </>
      )}
      <div className="text-[11.5px] leading-relaxed text-faint">
        Secrets are sealed with the system keychain. When editing, a key left with nothing after it keeps its saved value.
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[12.5px] text-dim">
          <Toggle on={draft.trust} onChange={(value) => set({ trust: value })} label="Trust this server" />
          Trust — run its tools without asking
        </label>
        <div className="flex-1" />
        <button type="button" onClick={onDone} className="rounded-lg px-3 py-1.5 text-[12.5px] text-dim transition-colors hover:text-brand">
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
        >
          {saving ? 'Connecting…' : draft.id === undefined ? 'Add server' : 'Save'}
        </button>
      </div>
      {error !== null && <div className="text-[12px] text-del">{error}</div>}
    </div>
  )
}

function ServerRow({ server, editing, onEdit }: { server: McpServerStatus; editing: boolean; onEdit: (id: string | null) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const toggle = (enabled: boolean): void => {
    void window.anticode.saveMcpServer({
      id: server.id,
      name: server.name,
      enabled,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: Object.fromEntries(server.envKeys.map((key) => [key, ''])),
      url: server.url,
      headers: Object.fromEntries(server.headerKeys.map((key) => [key, ''])),
      trust: server.trust
    })
  }

  return (
    <div className="border-b border-line-soft last:border-b-0">
      <div className="flex items-center gap-3 px-5 py-3.5">
        <button type="button" onClick={() => setOpen(!open)} className="group min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className="text-[13.5px] text-text transition-colors group-hover:text-brand">{server.name}</span>
            <span className={`text-[11.5px] ${server.state === 'error' ? 'text-del' : 'text-faint'}`}>
              {STATE_TEXT[server.state]}
              {server.state === 'ready' ? ` · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}` : ''}
              {server.trust ? ' · trusted' : ''}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
            {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
          </div>
          {server.state === 'error' && server.error !== null && <div className="mt-1 text-[11.5px] text-del">{server.error}</div>}
        </button>
        {server.state === 'error' && (
          <button
            type="button"
            onClick={() => void window.anticode.reconnectMcpServer(server.id)}
            className="rounded-md px-2 py-1 text-[12px] text-dim transition-colors hover:text-brand"
          >
            Retry
          </button>
        )}
        <button type="button" onClick={() => onEdit(editing ? null : server.id)} className="rounded-md px-2 py-1 text-[12px] text-dim transition-colors hover:text-brand">
          Edit
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => void window.anticode.removeMcpServer(server.id)}
            onMouseLeave={() => setConfirming(false)}
            className="rounded-md px-2 py-1 text-[12px] text-del transition-colors hover:text-del"
          >
            Remove?
          </button>
        ) : (
          <button
            type="button"
            aria-label={`Remove ${server.name}`}
            onClick={() => setConfirming(true)}
            className="rounded-md px-2 py-1 text-[12px] text-faint transition-colors hover:text-del"
          >
            ×
          </button>
        )}
        <Toggle on={server.enabled} onChange={toggle} label={`${server.name} on`} />
      </div>
      {open && server.tools.length > 0 && (
        <ul className="px-5 pb-3">
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex items-baseline gap-2 py-0.5 text-[12px]">
              <span className="shrink-0 font-mono text-dim">{tool.name}</span>
              {tool.destructive && <span className="shrink-0 text-[11px] text-del">destructive</span>}
              <span className="min-w-0 truncate text-faint">{tool.description}</span>
            </li>
          ))}
        </ul>
      )}
      {editing && <Editor initial={draftOf(server)} onDone={() => onEdit(null)} />}
    </div>
  )
}

/**
 * MCP servers whose tools anticode sessions can use. Each call is approved
 * like a built-in edit unless the server is trusted; antichat never gets them.
 */
export function Mcp(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [json, setJson] = useState('')
  const [importNote, setImportNote] = useState<string | null>(null)

  useEffect(() => {
    void window.anticode.listMcpServers().then(setServers)
    return window.anticode.onMcpServers(setServers)
  }, [])

  async function importJson(): Promise<void> {
    setImportNote(null)
    try {
      const count = await window.anticode.importMcpServers(json)
      setImportNote(`Added ${count} ${count === 1 ? 'server' : 'servers'}`)
      setJson('')
    } catch (failure) {
      setImportNote(errorText(failure))
    }
  }

  return (
    <>
      <h1 className="mb-6 text-[19px] text-text">MCP</h1>

      <div className="glass-surface mb-3 overflow-hidden rounded-xl border border-line">
        {servers.length === 0 && !adding && <div className="px-5 py-4 text-[12.5px] text-faint">No servers yet.</div>}
        {servers.map((server) => (
          <ServerRow key={server.id} server={server} editing={editing === server.id} onEdit={setEditing} />
        ))}
        {adding && <Editor initial={EMPTY} onDone={() => setAdding(false)} />}
      </div>
      {!adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="glass-control mb-8 rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors hover:text-brand"
        >
          Add server
        </button>
      )}

      <h2 className="mb-2 text-[14px] text-text">Import</h2>
      <textarea
        value={json}
        onChange={(event) => setJson(event.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "…" } } } }'}
        className="glass-field mb-2 w-full resize-none rounded-lg border px-3 py-2 font-mono text-[12px] text-text outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={json.trim() === ''}
          onClick={() => void importJson()}
          className="glass-control rounded-lg border px-3 py-1.5 text-[12.5px] text-text transition-colors enabled:hover:text-brand disabled:text-faint"
        >
          Import
        </button>
        {importNote !== null && <span className="text-[12px] text-faint">{importNote}</span>}
      </div>
    </>
  )
}
