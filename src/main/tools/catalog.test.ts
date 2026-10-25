import { expect, it } from 'vitest'
import { SessionToolCatalog } from './catalog'
import { modelTools } from './modelProfile'
import { toolsFor, subagentTools, definitionsOf } from './index'
import type { ToolContext } from './types'

const context: ToolContext = { workspaceRoot: '/tmp', signal: new AbortController().signal }

it('reduces initial schemas and loads only requested groups, scoped to each session', async () => {
  const source = (): ReturnType<typeof toolsFor> => toolsFor('code')
  const catalog = new SessionToolCatalog(source)
  const initial = catalog.tools()
  if (process.env.ANTICODE_MEASURE_TOOLS === '1') console.log(JSON.stringify({
    fullTools: source().length, initialTools: initial.length,
    fullSchemaBytes: Buffer.byteLength(JSON.stringify(definitionsOf(source()))),
    initialSchemaBytes: Buffer.byteLength(JSON.stringify(definitionsOf(initial))),
    gptInitialTools: modelTools(initial, 'cx/gpt-6.1-sol').length,
    gptSchemaBytes: Buffer.byteLength(JSON.stringify(definitionsOf(modelTools(initial, 'cx/gpt-6.1-sol'))))
  }))
  expect(initial.map((tool) => tool.name)).not.toContain('read_excel')
  expect(initial.map((tool) => tool.name)).toContain('fetch_url')
  expect(JSON.stringify(definitionsOf(initial)).length).toBeLessThan(JSON.stringify(definitionsOf(source())).length)
  await initial.find((tool) => tool.name === 'load_tools')!.prepare({ groups: ['documents'] }).execute(context)
  expect(catalog.tools().map((tool) => tool.name)).toContain('read_excel')
  expect(catalog.tools().map((tool) => tool.name)).not.toContain('browser_click')
  expect(new SessionToolCatalog(source).tools().map((tool) => tool.name)).not.toContain('read_excel')
})

it('loads account connectors one at a time, by name, and restores them from history', async () => {
  const connector = (name: string, tool: string): ReturnType<typeof toolsFor>[number] => ({
    name: `mcp__${name.replace(/ /g, '_')}__${tool}`, description: tool, inputSchema: { type: 'object' }, readOnly: false, connector: name,
    prepare: () => { throw new Error('unused') }
  })
  const source = (): ReturnType<typeof toolsFor> => [...toolsFor('code'), connector('Google Drive', 'update_file'), connector('Vercel', 'deploy')]
  const catalog = new SessionToolCatalog(source)
  const names = (): string[] => catalog.tools().map((tool) => tool.name)
  const loader = catalog.tools().find((tool) => tool.name === 'load_tools')!
  expect(loader.description).toContain('Google Drive (1)')
  expect(names()).not.toContain('mcp__Google_Drive__update_file')
  // The whole integrations group does not pull in every connector.
  const listed = await loader.prepare({ groups: ['integrations'] }).execute(context)
  expect(names()).not.toContain('mcp__Vercel__deploy')
  expect(JSON.stringify(listed)).toContain('Vercel (1)')
  await loader.prepare({ connectors: ['google drive', 'Notion'] }).execute(context)
  expect(names()).toContain('mcp__Google_Drive__update_file')
  expect(names()).not.toContain('mcp__Vercel__deploy')
  const reopened = new SessionToolCatalog(source)
  expect(reopened.tools([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'mcp__Vercel__deploy', input: {} }] }]).map((tool) => tool.name))
    .toContain('mcp__Vercel__deploy')
})

it('restores used capabilities from history without widening a read-only agent kit', () => {
  const catalog = new SessionToolCatalog(() => toolsFor('code'))
  expect(catalog.tools([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read_docx', input: {} }] }]).map((tool) => tool.name)).toContain('read_pdf')
  for (const model of ['cx/gpt-6.1-sol', 'claude-opus-4-7', 'clinepass/cline-pass/kimi-k3']) {
    expect(modelTools(subagentTools(), model).map((tool) => tool.name)).not.toContain('apply_patch')
  }
  expect(modelTools(toolsFor('code'), 'claude-opus-4-7').map((tool) => tool.name)).toContain('edit_file')
  expect(modelTools(toolsFor('code'), 'openai/gpt-oss-120b').map((tool) => tool.name)).toContain('write_file')
})
