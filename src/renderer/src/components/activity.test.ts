import { expect, it } from 'vitest'
import { activitySummary, integrationOf } from './activity'

it('names the integrations and the kinds of work, ChatGPT style', () => {
  expect(activitySummary([
    { name: 'mcp__Google_Drive__update_sheet' },
    { name: 'browser_navigate' },
    { name: 'read_file', input: { path: 'a.ts' } },
    { name: 'read_file', input: { path: 'b.ts' } },
    { name: 'run_command' },
    { name: 'run_command' }
  ])).toBe('Used Google Drive and Browser integrations, edited a file, read files, ran commands')
})

it('counts viewed images and singular work', () => {
  expect(activitySummary([
    { name: 'edit_file' },
    { name: 'run_command' },
    { name: 'read_file', input: { path: 'shot.png' } },
    { name: 'browser_screenshot' }
  ])).toBe('Used Browser integration, edited a file, ran a command, viewed 2 images')
})

it('is empty without tools and maps MCP servers to readable names', () => {
  expect(activitySummary([])).toBe('')
  expect(integrationOf('mcp__gdrive__search')).toBe('Google Drive')
  expect(integrationOf('mcp__GitHub_Server__create_issue')).toBe('GitHub Server')
  expect(integrationOf('read_file')).toBeNull()
})
