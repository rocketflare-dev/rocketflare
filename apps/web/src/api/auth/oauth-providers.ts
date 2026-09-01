/**
 * `oauth_providers` writes (D11, D12): link a provider identity to a user, list and unlink.
 * Tokens are encrypted before every write. `(provider, provider_user_id)` is UNIQUE, so one
 * external account can never attach to two users; `linkProvider` surfaces that as a conflict.
 */
import type { OAuthProviderName } from '@gmgo/shared/auth'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { oauthProviders } from '../../db/schema'
import { ConflictError } from '../utils/core/errors'
import { encryptToken } from './oauth-encryption'
import type { OAuthProfile, OAuthTokenSet } from './providers/types'

export async function findProviderLink(
  db: Database,
  provider: OAuthProviderName,
  providerUserId: string
) {
  return db.query.oauthProviders.findFirst({
    where: and(
      eq(oauthProviders.provider, provider),
      eq(oauthProviders.providerUserId, providerUserId)
    ),
  })
}

/** Insert or refresh the link for `(provider, providerUserId)` → `userId`. */
export async function upsertProviderLink(
  db: Database,
  cfg: AppConfig,
  userId: string,
  provider: OAuthProviderName,
  profile: OAuthProfile,
  tokens: OAuthTokenSet,
  scopes: string[]
): Promise<void> {
  const existing = await findProviderLink(db, provider, profile.providerUserId)
  if (existing && existing.userId !== userId) {
    throw new ConflictError(
      'This account is already linked to a different user',
      'provider_linked_elsewhere'
    )
  }
  const values = {
    email: profile.email,
    accessTokenEnc: await encryptToken(cfg, tokens.accessToken),
    refreshTokenEnc: await encryptToken(cfg, tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    scopes,
  }
  if (existing) {
    await db.update(oauthProviders).set(values).where(eq(oauthProviders.id, existing.id))
    return
  }
  await db
    .insert(oauthProviders)
    .values({ userId, provider, providerUserId: profile.providerUserId, ...values })
}

export interface LinkedProvider {
  provider: string
  email: string | null
  createdAt: Date
}

export async function listProviderLinks(db: Database, userId: string): Promise<LinkedProvider[]> {
  const rows = await db
    .select({
      provider: oauthProviders.provider,
      email: oauthProviders.email,
      createdAt: oauthProviders.createdAt,
    })
    .from(oauthProviders)
    .where(eq(oauthProviders.userId, userId))
    .orderBy(oauthProviders.createdAt)
  return rows
}

/** Magic link is always available, so unlinking the last provider is allowed. */
export async function unlinkProvider(
  db: Database,
  userId: string,
  provider: OAuthProviderName
): Promise<boolean> {
  const rows = await db
    .delete(oauthProviders)
    .where(and(eq(oauthProviders.userId, userId), eq(oauthProviders.provider, provider)))
    .returning({ id: oauthProviders.id })
  return rows.length > 0
}
