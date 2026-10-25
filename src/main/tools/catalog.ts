import { z } from 'zod'
import { defineTool } from './types'
import type { Tool } from './types'
import type { Message } from '../providers/types'

const CORE = new Set(['todo_write', 'task', 'ask_question', 'check_problems', 'read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory', 'search_files', 'share_file', 'run_command', 'web_search', 'fetch_url'])
const OFFICE = new Set(['read_excel', 'create_excel', 'write_excel_cell', 'add_excel_formula', 'format_excel_cells', 'read_docx', 'write_docx', 'read_pdf', 'create_pdf', 'fill_pdf_form'])
const MEDIA = new Set(['screenshot', 'generate_image'])
type Group = 'documents' | 'browser' | 'media' | 'integrations'

function groupFor(name: string): Group | null {
  if (CORE.has(name) || name === 'apply_patch') return null
  if (OFFICE.has(name)) return 'documents'
  if (MEDIA.has(name)) return 'media'
  if (name.startsWith('browser_') || name === 'read_network_requests') return 'browser'
  return 'integrations'
}

/** Connector names and tool counts, in the order they were offered. */
function connectorsIn(tools: Tool[]): Map<string, number> {
  const found = new Map<string, number>()
  for (const tool of tools) if (tool.connector !== undefined) found.set(tool.connector, (found.get(tool.connector) ?? 0) + 1)
  return found
}

function describeConnectors(found: Map<string, number>): string {
  return [...found].map(([name, count]) => `${name} (${count})`).join(', ')
}

/**
 * Tool schemas load once requested, independently for each session. Hosted
 * connectors of the session's own account (ChatGPT apps, claude.ai
 * connectors) can hold hundreds of tools, so each loads on its own, by name.
 */
export class SessionToolCatalog {
  private readonly loaded = new Set<Group>()
  private readonly connectors = new Set<string>()

  constructor(private readonly source: () => Tool[]) {}

  private loader(available: Map<string, number>): Tool {
    const names = [...available.keys()]
    const connectorNote = names.length > 0
      ? ` Connectors of the signed-in account for this model: ${describeConnectors(available)}; load one with connectors: ["${names[0]}"]. For files in Google Drive, Docs, Sheets or Slides use the Google Drive connector, not the browser.`
      : ''
    return defineTool({
      name: 'load_tools',
      description: `Load additional tools before using them: documents (Excel, Word, PDF); browser (interactive navigation, clicking, filling, screenshots, network); media (desktop screenshot, image generation); integrations (MCP servers set up in Settings).${connectorNote} Tools become callable on the next turn. Core coding, web_search and fetch_url are already available.`,
      readOnly: false,
      risk: 'low',
      schema: z.object({
        groups: z.array(z.enum(['documents', 'browser', 'media', 'integrations'])).default([]),
        connectors: z.array(z.string()).default([])
      }).refine((input) => input.groups.length + input.connectors.length > 0, 'Name at least one group or connector'),
      execute: (input) => {
        const all = this.source()
        const offered = connectorsIn(all)
        const byName = new Map([...offered.keys()].map((name) => [name.toLowerCase(), name]))
        const unknown: string[] = []
        for (const group of input.groups) this.loaded.add(group)
        for (const asked of input.connectors) {
          const name = byName.get(asked.trim().toLowerCase())
          if (name === undefined) unknown.push(asked)
          else this.connectors.add(name)
        }
        const selected = all.filter((tool) => tool.connector !== undefined
          ? input.connectors.some((asked) => byName.get(asked.trim().toLowerCase()) === tool.connector)
          : input.groups.includes(groupFor(tool.name) as Group))
        const notes = [
          ...(unknown.length > 0 ? [`Not connected for this account: ${unknown.join(', ')}.`] : []),
          ...(input.groups.includes('integrations') && offered.size > 0
            ? [`Account connectors, loaded separately with connectors: [...]: ${describeConnectors(offered)}.`]
            : [])
        ]
        const body = selected.length
          ? 'Loaded tools: ' + selected.map((tool) => `${tool.name}: ${tool.description}`).join('\n')
          : 'No tools are connected for these groups.'
        return Promise.resolve([body, ...notes].join('\n\n'))
      }
    })
  }

  tools(history: Message[] = []): Tool[] {
    const all = this.source()
    const present = new Map(all.map((tool) => [tool.name, tool]))
    // A reopened session retains capabilities it already used.
    for (const message of history) for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const tool = present.get(block.name)
      if (tool === undefined) continue
      if (tool.connector !== undefined) { this.connectors.add(tool.connector); continue }
      const group = groupFor(block.name)
      if (group !== null) this.loaded.add(group)
    }
    return [...all.filter((tool) => {
      if (tool.connector !== undefined) return this.connectors.has(tool.connector)
      const group = groupFor(tool.name)
      return group === null || this.loaded.has(group)
    }), this.loader(connectorsIn(all))]
  }
}
