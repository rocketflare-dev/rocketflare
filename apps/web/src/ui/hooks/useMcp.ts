/**
 * The organisation's MCP server: `GET /api/mcp/settings` (the settings plus the URLs to paste into
 * a client), `PUT` (any subset), and `GET /api/mcp/tools` (every tool the organisation has, with
 * what the CURRENT settings expose — computed server-side, so the page never re-derives it).
 * Owners and admins only (`manage McpSettings`), and only where the deployment ships `mcp`.
 *
 * Connections: `GET /api/mcp/connections` (this organisation's, admins) with `DELETE /:id` and
 * `POST /revoke-all`, and `GET /api/mcp-connections` (the reader's own, across organisations) with
 * `DELETE /:id`. A revoke refetches both lists — an admin revoking their own shows in both.
 */

import {
  type McpSettings,
  mcpSettingsResponseSchema,
  mcpSettingsSchema,
  mcpToolListResponseSchema,
  type UpdateMcpSettingsRequest,
} from '@rocketflare/shared/mcp'
import {
  mcpConnectionListResponseSchema,
  mcpRevokeAllResponseSchema,
} from '@rocketflare/shared/oauth'
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

export function useMcpConnections() {
  return useQuery({
    queryKey: queryKeys.mcp.connections,
    queryFn: () => api.get('/api/mcp/connections', { schema: mcpConnectionListResponseSchema }),
  })
}

export function useMyMcpConnections(enabled = true) {
  return useQuery({
    queryKey: queryKeys.mcp.myConnections,
    queryFn: () => api.get('/api/mcp-connections', { schema: mcpConnectionListResponseSchema }),
    enabled,
  })
}

function useRefetchConnections() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.connections }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.myConnections }),
    ])
}

/** Revoke one connection — as the organisation's admin (`tenant`) or as its owner (`own`). */
export function useRevokeMcpConnection(as: 'tenant' | 'own') {
  const refetch = useRefetchConnections()
  return useMutation({
    mutationFn: (id: string) =>
      api.delete(
        as === 'tenant' ? `/api/mcp/connections/${id}` : `/api/mcp-connections/${id}`,
        undefined,
        {
          showErrorToast: true,
        }
      ),
    onSuccess: refetch,
  })
}

export function useRevokeAllMcpConnections() {
  const refetch = useRefetchConnections()
  return useMutation({
    mutationFn: () =>
      api.post('/api/mcp/connections/revoke-all', undefined, {
        schema: mcpRevokeAllResponseSchema,
        showErrorToast: true,
      }),
    onSuccess: refetch,
  })
}
