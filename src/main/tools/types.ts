import { z } from 'zod'
import type { RiskTier, ToolPreview } from '@shared/ipc'

export class ToolError extends Error {}

/** One question handed to a sub-agent by the `task` tool. */
export interface DelegatedTask {
  description: string
  prompt: string
}

export interface ToolContext {
  sessionId?: string
  workspaceRoot: string
  signal: AbortSignal
  /** Runs a sub-agent and resolves to its report; absent inside a sub-agent. */
  delegate?: (task: DelegatedTask) => Promise<string>
}

export interface ToolImage {
  mediaType: string
  data: string
}

/**
 * Images cannot ride inside a tool result portably — OpenAI's tool messages are
 * text-only — so the loop appends them to the same user turn instead.
 */
export interface ToolOutput {
  isError?: boolean
  text: string
  images: ToolImage[]
  /** The change as a unified diff, for viewers only — the model never reads it. */
  diff?: string
}

/** A validated call: risk and preview are derived before anything is executed. */
export interface PreparedCall {
  risk: RiskTier
  preview: (context: ToolContext) => Promise<ToolPreview>
  execute: (context: ToolContext) => Promise<ToolOutput>
}

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * True means the call touches nothing shared, so it may run concurrently
   * with other such calls in one turn. Tools that mutate shared state — the
   * browser page, the network log — must be false even when read-only.
   */
  readOnly: boolean
  prepare: (rawInput: unknown) => PreparedCall
}

interface ToolSpec<S extends z.ZodType> {
  name: string
  description: string
  schema: S
  readOnly: boolean
  risk: RiskTier | ((input: z.output<S>) => RiskTier)
  preview?: (input: z.output<S>, context: ToolContext) => Promise<ToolPreview>
  execute: (input: z.output<S>, context: ToolContext) => Promise<string | ToolOutput>
}

/**
 * `io: 'input'` keeps fields with defaults out of `required`, so the model may
 * omit them. `$schema` is dropped because providers reject unknown top-level
 * keys in a tool's input schema.
 */
function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >
  return rest
}

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): Tool {
  return {
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    inputSchema: toInputSchema(spec.schema),
    prepare: (rawInput) => {
      const parsed = spec.schema.safeParse(rawInput)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
        throw new ToolError(`Invalid input — ${detail}`)
      }

      const input = parsed.data as z.output<S>
      return {
        risk: typeof spec.risk === 'function' ? spec.risk(input) : spec.risk,
        preview: async (context) =>
          spec.preview
            ? spec.preview(input, context)
            : { kind: 'text', subject: spec.name, detail: JSON.stringify(input, null, 2) },
        execute: async (context) => {
          context.signal.throwIfAborted()
          const result = await spec.execute(input, context)
          return typeof result === 'string' ? { text: result, images: [] } : result
        }
      }
    }
  }
}
