import type { SessionMode } from '@shared/ipc'
import type { ToolDefinition } from '../providers/types'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { listDirectoryTool } from './listDirectory'
import { runCommandTool } from './runCommand'
import { deleteFileTool } from './deleteFile'
import { searchFilesTool } from './searchFiles'
import {
  addExcelFormulaTool,
  createExcelTool,
  formatExcelCellsTool,
  readExcelTool,
  writeExcelCellTool
} from './excel'
import { readDocxTool, writeDocxTool } from './docx'
import { createPdfTool, fillPdfFormTool, readPdfTool } from './pdf'
import {
  browserClickTool,
  browserFillTool,
  browserGetTextTool,
  browserNavigateTool,
  browserScreenshotTool,
  fetchUrlTool,
  readNetworkRequestsTool
} from './browser'
import type { Tool } from './types'
import { todoWriteTool } from './todoWrite'
import { taskTool } from './task'

export const tools: Tool[] = [
  todoWriteTool,
  taskTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  searchFilesTool,
  runCommandTool,
  deleteFileTool,
  readExcelTool,
  createExcelTool,
  writeExcelCellTool,
  addExcelFormulaTool,
  formatExcelCellsTool,
  readDocxTool,
  writeDocxTool,
  readPdfTool,
  createPdfTool,
  fillPdfFormTool,
  fetchUrlTool,
  browserNavigateTool,
  browserGetTextTool,
  browserScreenshotTool,
  browserClickTool,
  browserFillTool,
  readNetworkRequestsTool
]

/**
 * What antichat may do with the files it is sent: read and edit documents in
 * its own private folder. No terminal, no deleting, no network, no browser —
 * it works on copies, and hands the results back as downloads.
 */
const CHAT_TOOL_NAMES = new Set([
  'todo_write',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'read_excel',
  'create_excel',
  'write_excel_cell',
  'add_excel_formula',
  'format_excel_cells',
  'read_docx',
  'write_docx',
  'read_pdf',
  'create_pdf',
  'fill_pdf_form'
])

/**
 * A sub-agent's kit: reading only. No editing, no terminal, no browser page
 * (it is shared with the parent), and no `task` of its own — one level deep.
 */
const SUBAGENT_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'read_excel',
  'read_docx',
  'read_pdf',
  'fetch_url'
])

/**
 * Tools from outside the app — MCP servers — registered by whoever runs them.
 * Asked on every request, since servers connect and change their lists while
 * sessions are open.
 */
let external: () => Tool[] = () => []

export function setExternalTools(source: () => Tool[]): void {
  external = source
}

/**
 * anticode gets the built-in tools plus the external ones; antichat only its
 * document kit — an MCP server can reach anything, so it stays out of there.
 */
export function toolsFor(mode: SessionMode): Tool[] {
  if (mode === 'chat') return tools.filter((tool) => CHAT_TOOL_NAMES.has(tool.name))
  const builtIn = new Set(tools.map((tool) => tool.name))
  return [...tools, ...external().filter((tool) => !builtIn.has(tool.name))]
}

export function subagentTools(): Tool[] {
  return tools.filter((tool) => SUBAGENT_TOOL_NAMES.has(tool.name))
}

export function definitionsOf(list: Tool[]): ToolDefinition[] {
  return list.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}

export function toolDefinitions(mode: SessionMode = 'code'): ToolDefinition[] {
  return definitionsOf(toolsFor(mode))
}

export { type Tool, ToolError } from './types'
