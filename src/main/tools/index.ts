import type { SessionMode } from '@shared/ipc'
import type { ToolDefinition } from '../providers/types'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { listDirectoryTool } from './listDirectory'
import { runCommandTool } from './runCommand'
import { deleteFileTool } from './deleteFile'
import { searchFilesTool } from './searchFiles'
import { shareFileTool } from './shareFile'
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
import { webSearchTool } from './webSearch'
import { askQuestionTool } from './askQuestion'
import { checkProblemsTool } from './checkProblems'
import { taskTool } from './task'
import { screenshotTool } from './screenshot'
import { generateImageTool } from './generateImage'

export const tools: Tool[] = [
  todoWriteTool,
  taskTool,
  askQuestionTool,
  checkProblemsTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  searchFilesTool,
  shareFileTool,
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
  webSearchTool,
  fetchUrlTool,
  browserNavigateTool,
  browserGetTextTool,
  browserScreenshotTool,
  browserClickTool,
  browserFillTool,
  readNetworkRequestsTool,
  screenshotTool,
  generateImageTool
]

/**
 * A sub-agent's kit: reading only. No editing, no terminal, no browser page
 * (it is shared with the parent), and no `task` of its own, one level deep.
 * Searching is reading too, and a sub-agent sent to find something out is the
 * one that needs it most; it runs on a page of its own, not the parent's.
 */
const SUBAGENT_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'check_problems',
  'read_excel',
  'read_docx',
  'read_pdf',
  'web_search',
  'fetch_url'
])

/**
 * Tools from outside the app, MCP servers, registered by whoever runs them.
 * Asked on every request, since servers connect and change their lists while
 * sessions are open.
 */
let external: () => Tool[] = () => []

export function setExternalTools(source: () => Tool[]): void {
  external = source
}

/**
 * Both modes get the same built-in and external tools. Their only capability
 * boundary is the workspace root: anticode uses the selected project, while
 * antichat uses a private folder owned by that session.
 */
export function toolsFor(_mode: SessionMode): Tool[] {
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
