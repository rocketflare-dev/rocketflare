/**
 * Which surface a tool is offered on, and how it reads to an MCP client. Pure: no database, no
 * config — `toolsFor` (`./index.ts`) applies {@link offeredOn} to the built list, and the MCP
 * server reads {@link mcpToolProfile} for the scope a call needs and the annotations it lists.
 */
import {
  type McpToolAnnotations,
  type McpToolScope,
  TOOL_SURFACES,
  type Tool,
  type ToolSurface,
} from '../../ai/agent-loop'

/** The surfaces a tool declares, or all of them. */
export function toolSurfaces(tool: Pick<Tool, 'surfaces'>): readonly ToolSurface[] {
  return tool.surfaces ?? TOOL_SURFACES
}

/** Does the tool carry a person-approval gate (always, or for some inputs)? */
export function hasApprovalGate(tool: Pick<Tool, 'requiresApproval' | 'requiresApprovalWhen'>) {
  return tool.requiresApproval === true || typeof tool.requiresApprovalWhen === 'function'
}

/**
 * Is this tool offered on `surface`? It must name the surface (or name none). On `mcp` it must
 * also have a handler — a terminal tool's input is an agent's answer, meaningless to a client —
 * and no approval gate, because an MCP client has nobody to ask.
 */
export function offeredOn(tool: Tool, surface: ToolSurface): boolean {
  if (!toolSurfaces(tool).includes(surface)) return false
  if (surface !== 'mcp') return true
  return typeof tool.handler === 'function' && !hasApprovalGate(tool)
}

/** Why a tool that names `mcp` is still not offered there, or `null` when it is. */
export function mcpUnavailableReason(tool: Tool): 'not_on_mcp' | 'terminal' | 'approval' | null {
  if (!toolSurfaces(tool).includes('mcp')) return 'not_on_mcp'
  if (typeof tool.handler !== 'function') return 'terminal'
  if (hasApprovalGate(tool)) return 'approval'
  return null
}

/** What an MCP client is told about a tool, every default filled in. */
export interface McpToolProfile {
  /** The scope a call needs. A scope only narrows what the person may do; it never grants. */
  scope: McpToolScope
  annotations: Required<McpToolAnnotations>
  title?: string
}

/**
 * The tool's MCP scope and annotations. A tool with `sideEffects` needs `mcp:write` and reads as
 * a non-read-only, destructive tool (idempotent only when `durable`); a read needs `mcp:read` and
 * reads as read-only and idempotent. `openWorldHint` defaults to `false` — a kit tool reads the
 * organisation's own data — and a tool that reaches the web says so in `mcp.annotations`.
 * `mcp.scope` and `mcp.annotations` override the derived values one field at a time.
 */
export function mcpToolProfile(tool: Tool): McpToolProfile {
  const writes = tool.sideEffects === true
  const scope = tool.mcp?.scope ?? (writes ? 'mcp:write' : 'mcp:read')
  const annotations: Required<McpToolAnnotations> = {
    readOnlyHint: !writes,
    destructiveHint: writes,
    idempotentHint: writes ? tool.durable === true : true,
    openWorldHint: false,
    ...definedOnly(tool.mcp?.annotations),
  }
  return {
    scope,
    annotations,
    ...(tool.mcp?.title !== undefined && { title: tool.mcp.title }),
  }
}

function definedOnly(annotations: McpToolAnnotations | undefined): McpToolAnnotations {
  if (!annotations) return {}
  return Object.fromEntries(Object.entries(annotations).filter(([, v]) => typeof v === 'boolean'))
}
