/**
 * The finished-run summary line, in words: which integrations were used and
 * what kinds of work were done, e.g. "Used Google Drive and Browser
 * integrations, edited a file, read files, ran commands".
 */
export interface ActivityTool {
  name: string
  input?: unknown
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i

/** The integration a tool belongs to, or null for a built-in workspace tool. */
export function integrationOf(name: string): string | null {
  const mcp = /^mcp__(.+?)__/.exec(name)
  if (mcp !== null) {
    const server = mcp[1]!.replace(/_+/g, ' ').trim()
    if (/google\s*drive|gdrive|\bdrive\b/i.test(server)) return 'Google Drive'
    if (/google\s*sheets?|gsheets?/i.test(server)) return 'Google Sheets'
    return server
  }
  if (name.startsWith('browser_') || name === 'read_network_requests') return 'Browser'
  return null
}

function pathOf(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const value = (input as { path?: unknown }).path
  return typeof value === 'string' ? value : ''
}

function isImageView(tool: ActivityTool): boolean {
  return tool.name === 'browser_screenshot' || tool.name === 'take_screenshot' ||
    (tool.name === 'read_file' && IMAGE_FILE.test(pathOf(tool.input)))
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`
}

export function activitySummary(tools: ActivityTool[]): string {
  const integrations: string[] = []
  const counts = { edit: 0, read: 0, search: 0, command: 0, image: 0, web: 0, share: 0, agent: 0 }
  for (const tool of tools) {
    const integration = integrationOf(tool.name)
    if (integration !== null && !integrations.includes(integration)) integrations.push(integration)
    const name = tool.name.replace(/^mcp__.+?__/, '')
    if (isImageView(tool)) counts.image += 1
    else if (tool.name === 'task') counts.agent += 1
    else if (tool.name === 'run_command') counts.command += 1
    else if (tool.name === 'share_file') counts.share += 1
    else if (/^(write|edit|delete|add|fill|create|format|update|apply|append|move|rename|copy)_?/i.test(name)) counts.edit += 1
    else if (/search|find|grep|query/i.test(name)) counts.search += 1
    else if (tool.name === 'fetch_url' || tool.name === 'web_search') counts.web += 1
    else if (integration === null || /^(read|get|list|export|download)/i.test(name)) counts.read += 1
  }
  const bits: string[] = []
  if (integrations.length > 0) {
    bits.push(`Used ${joinNames(integrations)} ${integrations.length === 1 ? 'integration' : 'integrations'}`)
  }
  const add = (count: number, one: string, many: string): void => { if (count > 0) bits.push(count === 1 ? one : many) }
  add(counts.edit, 'edited a file', 'edited files')
  add(counts.read, 'read a file', 'read files')
  add(counts.search, 'searched', 'searched')
  add(counts.web, 'browsed the web', 'browsed the web')
  add(counts.command, 'ran a command', 'ran commands')
  add(counts.image, 'viewed an image', `viewed ${counts.image} images`)
  add(counts.share, 'shared a file', 'shared files')
  add(counts.agent, 'used an agent', `used ${counts.agent} agents`)
  if (bits.length === 0) return ''
  const sentence = bits.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}
