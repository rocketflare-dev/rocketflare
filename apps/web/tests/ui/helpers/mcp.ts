/** A connection as `GET /api/mcp/connections` and `/api/mcp-connections` answer it. */
export const mcpConnection = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-000000000001',
  tenant: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Acme', slug: 'acme' },
  user: { id: '00000000-0000-4000-8000-0000000000bb', email: 'ana@acme.test', name: 'Ana' },
  client: {
    clientId: 'https://claude.ai/oauth/client.json',
    name: 'Claude',
    verifiedHost: 'claude.ai',
  },
  scopes: ['mcp:read'],
  resource: 'https://tools.example.test/mcp/t/acme',
  createdAt: '2026-11-01T00:00:00Z',
  lastUsedAt: '2026-11-19T00:00:00Z',
  expiresAt: '2027-02-01T00:00:00Z',
  calls30d: 7,
  status: 'live',
  revokedAt: null,
  revokeReason: null,
  ...over,
})
