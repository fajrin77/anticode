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

/** Tool schemas load once requested, independently for each session. */
export class SessionToolCatalog {
  private readonly loaded = new Set<Group>()
  private readonly loader: Tool

  constructor(private readonly source: () => Tool[]) {
    this.loader = defineTool({
      name: 'load_tools',
      description: 'Load additional tools before using them: documents (Excel, Word, PDF); browser (interactive navigation, clicking, filling, screenshots, network); media (desktop screenshot, image generation); integrations (connected MCP tools, including Google Drive/Docs/Sheets/Slides editing through the signed-in ChatGPT account when available; prefer it over the browser for files in Drive). Tools become callable on the next turn. Core coding, web_search and fetch_url are already available.',
      readOnly: false,
      risk: 'low',
      schema: z.object({ groups: z.array(z.enum(['documents', 'browser', 'media', 'integrations'])).min(1) }),
      execute: (input) => {
        for (const group of input.groups) this.loaded.add(group)
        const selected = this.source().filter((tool) => input.groups.includes(groupFor(tool.name) as Group))
        return Promise.resolve(selected.length
          ? 'Loaded tools: ' + selected.map((tool) => `${tool.name}: ${tool.description}`).join('\n')
          : 'No tools are connected for these groups.')
      }
    })
  }

  tools(history: Message[] = []): Tool[] {
    const all = this.source()
    const present = new Map(all.map((tool) => [tool.name, tool]))
    // A reopened session retains capabilities it already used.
    for (const message of history) for (const block of message.content) {
      if (block.type !== 'tool_use' || !present.has(block.name)) continue
      const group = groupFor(block.name)
      if (group !== null) this.loaded.add(group)
    }
    return [...all.filter((tool) => {
      const group = groupFor(tool.name)
      return group === null || this.loaded.has(group)
    }), this.loader]
  }
}
