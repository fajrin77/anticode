import type { Tool } from './types'
import { applyPatchTool } from './applyPatch'

export function usesPatch(model: string): boolean {
  const id = model.toLowerCase().split('/').at(-1) ?? ''
  return (/^gpt-(?:[5-9]|[1-9]\d)(?:[.:-]|$)/.test(id) && !id.includes('oss')) || /^codex(?:-|$)/.test(id)
}

/** Keep capability boundaries intact: read-only/fixed kits never acquire patch. */
export function modelTools(tools: Tool[], model: string): Tool[] {
  if (!usesPatch(model) || !tools.some((tool) => tool.name === 'edit_file')) return tools
  return [...tools.filter((tool) => !['edit_file', 'write_file', 'delete_file'].includes(tool.name)), applyPatchTool]
}

export function editingGuidance(model: string): string {
  return usesPatch(model)
    ? 'Use apply_patch to add, update, or delete workspace text files; read existing files first. Include exact, unique context in update hunks.'
    : 'Use edit_file for targeted changes to existing text files; use write_file for new files and delete_file for deletions.'
}
