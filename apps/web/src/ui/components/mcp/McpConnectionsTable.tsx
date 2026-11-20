/**
 * The MCP connections table, in its two places: Settings → MCP (every connection in the
 * organisation — who, through which client) and Profile → Connected apps (the reader's own, in
 * every organisation). Each row names the client by what its metadata document CLAIMS and by the
 * host its `client_id` was fetched from — the host is the verified part. Revoking asks first; the
 * client's next call fails.
 */
import type { McpConnection } from '@rocketflare/shared/oauth'
import { useState } from 'react'
import { ConfirmModal } from '@/ui/components/shared'
import { formatDate, timeAgo } from '@/ui/lib/format'

export function clientLabel(c: McpConnection): string {
  return c.client.name ?? c.client.verifiedHost
}

export function McpConnectionsTable({
  connections,
  show,
  revoking,
  onRevoke,
}: {
  connections: McpConnection[]
  /** `person` for the organisation's list, `organisation` for the reader's own. */
  show: 'person' | 'organisation'
  revoking: boolean
  onRevoke: (c: McpConnection, done: () => void) => void
}) {
  const [confirming, setConfirming] = useState<McpConnection | null>(null)
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>{show === 'person' ? 'Person' : 'Organisation'}</th>
            <th>Client</th>
            <th>Access</th>
            <th>Connected</th>
            <th>Last used</th>
            <th className="text-right">Calls (30 days)</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {connections.map(c => (
            <tr key={c.id}>
              <td className="font-medium">
                {show === 'person' ? (c.user.name ?? c.user.email) : c.tenant.name}
                {show === 'person' && c.user.name && (
                  <span className="block text-xs text-muted font-normal">{c.user.email}</span>
                )}
              </td>
              <td>
                {clientLabel(c)}
                <span
                  className="block text-xs text-muted"
                  title="Verified from the client's address"
                >
                  {c.client.verifiedHost}
                </span>
              </td>
              <td className="text-secondary text-xs">
                {c.scopes.includes('mcp:write') ? 'Read and make changes' : 'Read'}
              </td>
              <td className="text-secondary whitespace-nowrap">{formatDate(c.createdAt)}</td>
              <td className="text-secondary whitespace-nowrap">{timeAgo(c.lastUsedAt)}</td>
              <td className="text-right tabular-nums">{c.calls30d}</td>
              <td className="text-right">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs text-error"
                  onClick={() => setConfirming(c)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmModal
        isOpen={confirming !== null}
        title="Revoke connection"
        message={
          confirming
            ? `Disconnect ${clientLabel(confirming)}${show === 'person' ? ` for ${confirming.user.name ?? confirming.user.email}` : ` from ${confirming.tenant.name}`}? Its next call fails, and connecting again needs a new sign-in.`
            : ''
        }
        confirmText="Revoke"
        confirmButtonClass="btn-error"
        isLoading={revoking}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) onRevoke(confirming, () => setConfirming(null))
        }}
      />
    </div>
  )
}
