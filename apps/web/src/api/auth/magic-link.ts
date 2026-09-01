/**
 * One-time email login tokens (D11, D12): 32 random bytes in the URL, SHA-256 in
 * `magic_link_tokens`, 15-minute expiry, consumed atomically (`UPDATE … WHERE consumed_at IS NULL
 * RETURNING`) so a double-click yields `invalid_token` for the second request. Keyed by email —
 * the user row may not exist yet; `admitUser` decides that at verify time (D9).
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { magicLinkTokens } from '../../db/schema'
import { hashToken } from '../utils/core/hash'
import { randomToken } from '../utils/core/ids'

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000

export interface IssuedMagicLink {
  /** Raw token for the URL. Never stored. */
  token: string
  expiresAt: Date
}

export async function issueMagicLinkToken(
  db: Database,
  email: string,
  redirectTo: string | null
): Promise<IssuedMagicLink> {
  const token = randomToken(32)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS)
  await db.insert(magicLinkTokens).values({
    email: email.toLowerCase(),
    tokenHash: await hashToken(token),
    redirectTo,
    expiresAt,
  })
  return { token, expiresAt }
}

export type MagicLinkConsumeResult =
  | { ok: true; email: string; redirectTo: string | null }
  | { ok: false; reason: 'invalid_token' | 'expired' }

/** Consume exactly once. An expired row is reported as `expired` (and left for the nightly prune). */
export async function consumeMagicLinkToken(
  db: Database,
  token: string
): Promise<MagicLinkConsumeResult> {
  if (!token || token.length > 256) return { ok: false, reason: 'invalid_token' }
  const tokenHash = await hashToken(token)
  const [row] = await db
    .update(magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(magicLinkTokens.tokenHash, tokenHash), isNull(magicLinkTokens.consumedAt)))
    .returning({
      email: magicLinkTokens.email,
      redirectTo: magicLinkTokens.redirectTo,
      expiresAt: magicLinkTokens.expiresAt,
    })
  if (!row) return { ok: false, reason: 'invalid_token' }
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' }
  return { ok: true, email: row.email, redirectTo: row.redirectTo }
}

/** Nightly prune (scheduled.ts): expired or consumed rows. Returns the count removed. */
export async function pruneMagicLinkTokens(db: Database): Promise<number> {
  const rows = await db
    .delete(magicLinkTokens)
    .where(sql`${magicLinkTokens.expiresAt} < now() OR ${magicLinkTokens.consumedAt} IS NOT NULL`)
    .returning({ id: magicLinkTokens.id })
  return rows.length
}
