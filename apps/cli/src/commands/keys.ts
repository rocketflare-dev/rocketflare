/** `rocketflare keys list` — `GET /api/keys`; accepts a bare array or a paginated envelope of `apiKeySchema` (D26). */
import { apiKeySchema } from '@rocketflare/shared/api-keys'
import { paginatedResponse } from '@rocketflare/shared/pagination'
import { z } from 'zod'
import { type CommandContext, requireClient } from '../context'
import { formatDate, formatPagination, renderTable } from '../utils/output'

export const keysListSchema = z.union([z.array(apiKeySchema), paginatedResponse(apiKeySchema)])

export async function runKeysList(ctx: CommandContext): Promise<void> {
  const { data, raw } = await requireClient(ctx).request('GET', '/api/keys', {
    schema: keysListSchema,
  })
  const items = Array.isArray(data) ? data : data.items
  ctx.out.data(raw, () =>
    renderTable(items, [
      { header: 'Name', value: k => k.name },
      { header: 'Prefix', value: k => k.keyPrefix },
      { header: 'Scopes', value: k => k.scopes.join(',') },
      { header: 'Created', value: k => formatDate(k.createdAt) },
      { header: 'Last used', value: k => formatDate(k.lastUsedAt) },
      { header: 'Expires', value: k => formatDate(k.expiresAt) },
      { header: 'Revoked', value: k => formatDate(k.revokedAt) },
    ])
  )
  if (!Array.isArray(data)) ctx.out.text(formatPagination(data.pagination))
}
