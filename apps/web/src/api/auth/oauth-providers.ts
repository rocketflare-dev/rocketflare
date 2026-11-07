/**
 * `oauth_providers` writes: link a provider identity to a user, list and unlink.
 * Tokens are encrypted before every write. `(provider, provider_user_id)` is UNIQUE, so one
 * external account can never attach to two users; `linkProvider` surfaces that as a conflict.
 */
import type { OAuthProviderName } from '@rocketflare/shared/auth'
import { and, eq } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import { type Database, isUniqueViolation } from '../../db/client'
import { oauthProviders } from '../../db/schema'
import { ConflictError } from '../utils/core/errors'
import { encryptToken } from './oauth-encryption'
import type { OAuthProfile, OAuthTokenSet } from './providers/types'

/**
 * A plugin's identities are stored beside the built-in providers' under `plugin:<id>`
 * (`plugins/api/identity.ts`), so `(provider, provider_user_id)` stays the one uniqueness rule and
 * no plugin can collide with `google`, `oidc` or another plugin.
 */
export type PluginProviderKey = `plugin:${string}`
export type ProviderKey = OAuthProviderName | PluginProviderKey

export async function findProviderLink(
  db: Database,
  provider: ProviderKey,
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

/**
 * Link a plugin-asserted identity (no tokens: the plugin's IdP proved the person, nothing is
 * called on their behalf afterwards). Idempotent for the same user, refreshing the asserted email;
 * 409 `provider_linked_elsewhere` when the subject already belongs to someone else — including a
 * concurrent insert losing the unique race.
 */
export async function linkPluginIdentity(
  db: Database,
  input: { userId: string; provider: PluginProviderKey; providerUserId: string; email: string }
): Promise<void> {
  const elsewhere = () =>
    new ConflictError(
      'This account is already linked to a different user',
      'provider_linked_elsewhere'
    )
  const existing = await findProviderLink(db, input.provider, input.providerUserId)
  if (existing && existing.userId !== input.userId) throw elsewhere()
  if (existing) {
    if (existing.email !== input.email) {
      await db
        .update(oauthProviders)
        .set({ email: input.email })
        .where(eq(oauthProviders.id, existing.id))
    }
    return
  }
  try {
    await db.insert(oauthProviders).values({
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email,
    })
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const winner = await findProviderLink(db, input.provider, input.providerUserId)
    if (winner?.userId !== input.userId) throw elsewhere()
  }
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
