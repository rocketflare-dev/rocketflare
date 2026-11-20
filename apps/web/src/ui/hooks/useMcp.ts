/**
 * The organisation's MCP server: `GET /api/mcp/settings` (the settings plus the URLs to paste into
 * a client), `PUT` (any subset), and `GET /api/mcp/tools` (every tool the organisation has, with
 * what the CURRENT settings expose — computed server-side, so the page never re-derives it).
 * Owners and admins only (`manage McpSettings`), and only where the deployment ships `mcp`.
 */
import {
  type McpSettings,
  mcpSettingsResponseSchema,
  mcpSettingsSchema,
  mcpToolListResponseSchema,
  type UpdateMcpSettingsRequest,
} from '@rocketflare/shared/mcp'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function mcpSettingsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mcp.settings,
    queryFn: () => api.get('/api/mcp/settings', { schema: mcpSettingsResponseSchema }),
  })
}

export function useMcpSettings() {
  return useQuery(mcpSettingsQueryOptions())
}

export function mcpToolsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.mcp.tools,
    queryFn: () => api.get('/api/mcp/tools', { schema: mcpToolListResponseSchema }),
  })
}

export function useMcpTools() {
  return useQuery(mcpToolsQueryOptions())
}

/**
 * Send only what changed. The answer is the saved settings; the tool list is refetched too,
 * because each row's `exposed` follows the exposure mode.
 */
export function useUpdateMcpSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: UpdateMcpSettingsRequest) =>
      api.put<McpSettings>('/api/mcp/settings', patch, { schema: mcpSettingsSchema }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.mcp.all }),
  })
}
