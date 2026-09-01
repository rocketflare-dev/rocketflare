/**
 * `/api/keys` (D12): tenant API keys. Admin+ throughout; the plaintext appears exactly once, in the
 * `POST` response. Revoke is soft (`revokedAt`), never a delete.
 */
import type { ApiKey as ApiKeyDto } from '@gmgo/shared/api-keys'
import { createApiKeyRequestSchema } from '@gmgo/shared/api-keys'
import { paginationMeta, paginationQuerySchema } from '@gmgo/shared/pagination'
import { and, count, desc, eq } from 'drizzle-orm'
import { type ApiKey, apiKeys } from '../../db/schema'
import { mintApiKey } from '../auth/api-keys'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import { NotFoundError } from '../utils/core/errors'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const keysRouter = createRouter()

function toDto(row: ApiKey): ApiKeyDto {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as ApiKeyDto['scopes'],
    createdByUserId: row.createdByUserId,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}

keysRouter.get('/', validate('query', paginationQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'ApiKey')
  const { page, pageSize } = c.req.valid('query')
  const where = eq(apiKeys.tenantId, tenantId)
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(apiKeys)
      .where(where)
      .orderBy(desc(apiKeys.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(apiKeys).where(where),
  ])
  return c.json({ items: rows.map(toDto), pagination: paginationMeta(page, pageSize, total) })
})

keysRouter.post('/', validate('json', createApiKeyRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'ApiKey')
  const body = c.req.valid('json')
  const { row, plaintext } = await mintApiKey(db, {
    tenantId,
    createdByUserId: user.id,
    name: body.name,
    scopes: body.scopes,
    expiresAt: body.expiresAt ?? null,
  })
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'api_key.created',
      subjectType: 'ApiKey',
      subjectId: row.id,
      metadata: { name: row.name, scopes: row.scopes },
    })
  )
  return c.json({ ...toDto(row), key: plaintext }, 201)
})

keysRouter.delete('/:id', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'ApiKey')
  const id = uuidParam(c, 'id')
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId)))
    .returning()
  if (!row) throw new NotFoundError('API key not found')
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'api_key.revoked',
      subjectType: 'ApiKey',
      subjectId: row.id,
      metadata: { name: row.name },
    })
  )
  return c.body(null, 204)
})
