/**
 * Tenant API keys (D12): `Authorization: Bearer <key>` on `/api/*`. Validation is one query (key →
 * creator → creator's membership in the key's tenant → tenant), then `revokedAt`/`expiresAt`
 * (neither reference app checked expiry), creator blocked, membership gone, tenant suspended.
 * `lastUsedAt` is stamped at most every 5 minutes, through `waitUntil`.
 */
import type { MembershipRole, TenantStatus } from '@gmgo/shared/tenants'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { type ApiKey, apiKeys, tenants, tenantUsers, type User, users } from '../../db/schema'
import { generateApiKey, hashToken } from '../utils/core/hash'

export type ApiKeyValidation =
  | {
      ok: true
      key: Pick<ApiKey, 'id' | 'tenantId' | 'scopes' | 'lastUsedAt'>
      user: User
      role: MembershipRole
      tenant: { id: string; name: string; slug: string; status: TenantStatus }
    }
  | { ok: false; reason: 'invalid' | 'revoked' | 'expired' | 'no_membership' }

export async function validateApiKey(db: Database, plaintext: string): Promise<ApiKeyValidation> {
  if (!plaintext || plaintext.length > 256) return { ok: false, reason: 'invalid' }
  const keyHash = await hashToken(plaintext)
  const [row] = await db
    .select({
      key: {
        id: apiKeys.id,
        tenantId: apiKeys.tenantId,
        scopes: apiKeys.scopes,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        expiresAt: apiKeys.expiresAt,
      },
      user: users,
      role: tenantUsers.role,
      tenant: { id: tenants.id, name: tenants.name, slug: tenants.slug, status: tenants.status },
    })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdByUserId))
    .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
    .leftJoin(
      tenantUsers,
      and(
        eq(tenantUsers.tenantId, apiKeys.tenantId),
        eq(tenantUsers.userId, apiKeys.createdByUserId)
      )
    )
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1)
  if (!row) return { ok: false, reason: 'invalid' }
  if (row.key.revokedAt) return { ok: false, reason: 'revoked' }
  if (row.key.expiresAt && row.key.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  if (!row.role) return { ok: false, reason: 'no_membership' }
  return {
    ok: true,
    key: {
      id: row.key.id,
      tenantId: row.key.tenantId,
      scopes: row.key.scopes,
      lastUsedAt: row.key.lastUsedAt,
    },
    user: row.user,
    role: row.role,
    tenant: row.tenant,
  }
}

/** Stamp `last_used_at` — the predicate makes it a no-op within 5 minutes of the last stamp. */
export async function touchApiKeyUsage(db: Database, keyId: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, sql`now() - interval '5 minutes'`))
      )
    )
}

export interface MintApiKeyInput {
  tenantId: string
  createdByUserId: string
  name: string
  scopes: string[]
  expiresAt?: Date | null
}

/** The ONE way a key comes into existence — `POST /api/keys` and `GET /auth/cli` both use it. */
export async function mintApiKey(db: Database, input: MintApiKeyInput) {
  const generated = await generateApiKey()
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: input.tenantId,
      createdByUserId: input.createdByUserId,
      name: input.name,
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
  if (!row) throw new Error('mintApiKey: insert returned no row')
  return { row, plaintext: generated.key }
}
