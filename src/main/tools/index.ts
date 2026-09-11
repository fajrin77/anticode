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

export const tools: Tool[] = [
  todoWriteTool,
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

export function toolsFor(mode: SessionMode): Tool[] {
  return mode === 'chat' ? tools.filter((tool) => CHAT_TOOL_NAMES.has(tool.name)) : tools
}

export function toolDefinitions(mode: SessionMode = 'code'): ToolDefinition[] {
  return toolsFor(mode).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}

export { type Tool, ToolError } from './types'
