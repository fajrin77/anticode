import type { ToolDefinition } from '../providers/types'
import { readFileTool } from './readFile'
import { writeFileTool } from './writeFile'
import { editFileTool } from './editFile'
import { listDirectoryTool } from './listDirectory'
import { runCommandTool } from './runCommand'
import { deleteFileTool } from './deleteFile'
import { searchFilesTool } from './searchFiles'
import { addExcelFormulaTool, readExcelTool, writeExcelCellTool } from './excel'
import { readDocxTool, writeDocxTool } from './docx'
import { fillPdfFormTool, readPdfTool } from './pdf'
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

export const tools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
  searchFilesTool,
  runCommandTool,
  deleteFileTool,
  readExcelTool,
  writeExcelCellTool,
  addExcelFormulaTool,
  readDocxTool,
  writeDocxTool,
  readPdfTool,
  fillPdfFormTool,
  fetchUrlTool,
  browserNavigateTool,
  browserGetTextTool,
  browserScreenshotTool,
  browserClickTool,
  browserFillTool,
  readNetworkRequestsTool
]

export function toolDefinitions(): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}

export { type Tool, ToolError } from './types'
