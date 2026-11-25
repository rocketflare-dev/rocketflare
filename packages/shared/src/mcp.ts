/**
 * The MCP server's contracts: an organisation's MCP settings (on/off, what is exposed, who may
 * connect), the tool listing the settings page renders, and one row of the call log. The OAuth
 * documents and the consent screen have contracts of their own; nothing here names the product —
 * what a client sees is the deployment's own name.
 */
import { z } from 'zod'

/** The two scopes a client may hold. A scope only narrows what the person may do; it never grants. */
export const MCP_SCOPES = ['mcp:read', 'mcp:write'] as const
export const mcpScopeSchema = z.enum(MCP_SCOPES)
export type McpScope = z.infer<typeof mcpScopeSchema>

/**
 * A tool name every surface accepts: 1–64 of `A–Z a–z 0–9 _ -`. MCP allows 128 characters and `.`,
 * but the same tool goes to the chat models, whose APIs refuse a dot and anything past 64 — so the
 * name is the intersection. A kit or plugin tool is snake_case anyway. `pnpm plugin check` and the
 * tool builder both enforce it (`scripts/lib/plugin-lib.mjs` keeps a copy, pinned equal by a test).
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * What the organisation exposes:
 * - `read_only` (the default) — every read-only tool, new ones included;
 * - `all` — every tool, writes too, new ones included (a write still needs `mcp:write`);
 * - `selected` — only the tools named in `exposedTools`.
 */
export const MCP_EXPOSURE_MODES = ['read_only', 'all', 'selected'] as const
export const mcpExposureSchema = z.enum(MCP_EXPOSURE_MODES)
export type McpExposure = z.infer<typeof mcpExposureSchema>

/** Who may connect a client: every member (default), owners and admins only, or chosen groups. */
export const MCP_CONNECT_POLICIES = ['everyone', 'admins', 'groups'] as const
export const mcpConnectPolicySchema = z.enum(MCP_CONNECT_POLICIES)
export type McpConnectPolicy = z.infer<typeof mcpConnectPolicySchema>

const toolNameSchema = z.string().regex(MCP_TOOL_NAME_PATTERN, 'not a valid tool name')

export const mcpSettingsSchema = z.object({
  enabled: z.boolean(),
  exposure: mcpExposureSchema,
  /** Read only under `selected`; kept when the mode changes so switching back restores the ticks. */
  exposedTools: z.array(toolNameSchema),
  connectPolicy: mcpConnectPolicySchema,
  /** Read only under `groups`. */
  connectGroupIds: z.array(z.string().uuid()),
  updatedAt: z.coerce.date().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
})
export type McpSettings = z.infer<typeof mcpSettingsSchema>

/** `GET /api/mcp/settings` — the settings plus the URLs a person pastes into a client. */
export const mcpSettingsResponseSchema = z.object({
  settings: mcpSettingsSchema,
  /** `<APP_URL>/mcp` — the organisation is chosen when the client connects. */
  serverUrl: z.string().url(),
  /**
   * `<APP_URL>/mcp/t/<slug>` — pinned to this organisation. A client that keys connectors by URL
   * (claude.ai) needs this one to connect a second organisation.
   */
  organisationServerUrl: z.string().url(),
  /** The deployment's name, for the setup snippets. */
  serverName: z.string(),
})
export type McpSettingsResponse = z.infer<typeof mcpSettingsResponseSchema>

/** `PUT /api/mcp/settings` — any subset; what is absent is left as it is. */
export const updateMcpSettingsRequestSchema = z
  .object({
    enabled: z.boolean(),
    exposure: mcpExposureSchema,
    exposedTools: z.array(toolNameSchema).max(500),
    connectPolicy: mcpConnectPolicySchema,
    connectGroupIds: z.array(z.string().uuid()).max(100),
  })
  .partial()
  .strict()
  .refine(body => Object.keys(body).length > 0, 'nothing to update')
export type UpdateMcpSettingsRequest = z.infer<typeof updateMcpSettingsRequestSchema>

/** Why a tool cannot reach an MCP client whatever the exposure mode — shown greyed out. */
export const MCP_UNAVAILABLE_REASONS = ['not_on_mcp', 'terminal', 'approval'] as const
export const mcpUnavailableReasonSchema = z.enum(MCP_UNAVAILABLE_REASONS)
export type McpUnavailableReason = z.infer<typeof mcpUnavailableReasonSchema>

export const mcpToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean(),
  destructiveHint: z.boolean(),
  idempotentHint: z.boolean(),
  openWorldHint: z.boolean(),
})

/** One row of the settings page's tool list. */
export const mcpToolListingSchema = z.object({
  name: z.string(),
  /** `core` for the kit's own tools, else the plugin id that contributes it. */
  provider: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  scope: mcpScopeSchema,
  readOnly: z.boolean(),
  annotations: mcpToolAnnotationsSchema,
  /** Non-null: never listed to a client, in any mode. */
  unavailableReason: mcpUnavailableReasonSchema.nullable(),
  /** Would a client with every scope see it under the CURRENT settings? */
  exposed: z.boolean(),
  /** Calls in the last 30 days, every outcome. */
  calls30d: z.number().int().nonnegative(),
})
export type McpToolListing = z.infer<typeof mcpToolListingSchema>

export const mcpToolListResponseSchema = z.object({ tools: z.array(mcpToolListingSchema) })
export type McpToolListResponse = z.infer<typeof mcpToolListResponseSchema>

/**
 * How a call ended: `ok`; `error` (the tool answered `isError`, a bad argument included);
 * `rate_limited` (a per-connection or per-organisation cap); `denied` (a missing scope).
 */
export const MCP_CALL_OUTCOMES = ['ok', 'error', 'rate_limited', 'denied'] as const
export const mcpCallOutcomeSchema = z.enum(MCP_CALL_OUTCOMES)
export type McpCallOutcome = z.infer<typeof mcpCallOutcomeSchema>

/** One call, as the log keeps it: who, through which connection, which tool — never the arguments. */
export const mcpToolCallSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  grantId: z.string().uuid().nullable(),
  clientId: z.string(),
  tool: z.string(),
  outcome: mcpCallOutcomeSchema,
  code: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  costMicrocents: z.number().int().nullable(),
  createdAt: z.coerce.date(),
})
export type McpToolCall = z.infer<typeof mcpToolCallSchema>

export const mcpToolCallListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  tool: toolNameSchema.optional(),
  userId: z.string().uuid().optional(),
})
export const mcpToolCallListResponseSchema = z.object({ items: z.array(mcpToolCallSchema) })
export type McpToolCallListResponse = z.infer<typeof mcpToolCallListResponseSchema>
