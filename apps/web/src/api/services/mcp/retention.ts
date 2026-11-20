/**
 * The MCP server's nightly retention, one DELETE per table across every tenant (like the span
 * prune): calls older than `MCP_CALL_RETENTION_DAYS`, and tokens past their own expiry — an
 * expired token can never be presented again, so keeping its hash buys nothing — and the
 * authorization server's requests and codes past their deadline. Grants are kept,
 * revoked or lapsed, so the admin's list still says who connected what and when it ended.
 */
import { and, isNotNull, lt } from 'drizzle-orm'
import { affected, type Database } from '../../../db/client'
import { mcpTokens, mcpToolCalls } from '../../../db/schema'
import { MCP_REFRESH_RETRY_GRACE_MS, pruneOAuthRequests } from './authorization'

export async function runPruneMcp(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const calls = affected(await db.delete(mcpToolCalls).where(lt(mcpToolCalls.createdAt, cutoff)))
  const tokens = affected(await db.delete(mcpTokens).where(lt(mcpTokens.expiresAt, now)))
  // A spent refresh token's sealed successor is only openable inside the retry grace; past it the
  // ciphertext is dead weight, so it goes (a refresh already clears its own grant's).
  const sealed = affected(
    await db
      .update(mcpTokens)
      .set({ successorSealed: null })
      .where(
        and(
          isNotNull(mcpTokens.successorSealed),
          lt(mcpTokens.usedAt, new Date(now.getTime() - MCP_REFRESH_RETRY_GRACE_MS))
        )
      )
  )
  const requests = await pruneOAuthRequests(db, now)
  return { calls, tokens, sealed, requests, cutoff: cutoff.toISOString() }
}
