/**
 * The MCP server's nightly retention, one DELETE per table across every tenant (like the span
 * prune): calls older than `MCP_CALL_RETENTION_DAYS`, and tokens past their own expiry — an
 * expired token can never be presented again, so keeping its hash buys nothing — and the
 * authorization server's requests and codes past their deadline. Grants are kept,
 * revoked or lapsed, so the admin's list still says who connected what and when it ended — except
 * a grant whose code was never redeemed, which never became a connection and goes once its code
 * can no longer be exchanged. A cached client metadata document goes once it has not been fetched
 * for `CLIENT_CACHE_DAYS` and no grant or pending request names its client.
 */
import { and, isNotNull, isNull, lt, notExists, sql } from 'drizzle-orm'
import { affected, type Database } from '../../../db/client'
import { mcpGrants, mcpTokens, mcpToolCalls, oauthClients, oauthRequests } from '../../../db/schema'
import { MCP_REFRESH_RETRY_GRACE_MS, pruneOAuthRequests } from './authorization'

/**
 * How long a consent's grant may wait for its code to be redeemed before the sweep takes it — far
 * past the code's own sixty seconds, so a sweep can never race a live exchange.
 */
const UNREDEEMED_GRANT_MS = 60 * 60 * 1000

/**
 * How long an unreferenced client metadata document stays cached. A client in use is refetched
 * daily, so a row this stale belongs to a client nobody has authorized with for a month; it is a
 * cache, and the next authorization fetches it again.
 */
const CLIENT_CACHE_DAYS = 30

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
  const unredeemed = affected(
    await db
      .delete(mcpGrants)
      .where(
        and(
          isNull(mcpGrants.activatedAt),
          lt(mcpGrants.createdAt, new Date(now.getTime() - UNREDEEMED_GRANT_MS))
        )
      )
  )
  const clients = affected(
    await db.delete(oauthClients).where(
      and(
        lt(oauthClients.fetchedAt, new Date(now.getTime() - CLIENT_CACHE_DAYS * 86_400_000)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(mcpGrants)
            .where(sql`${mcpGrants.clientId} = ${oauthClients.clientId}`)
        ),
        // What survives `pruneOAuthRequests` above is at most a day past its deadline.
        notExists(
          db
            .select({ one: sql`1` })
            .from(oauthRequests)
            .where(sql`${oauthRequests.clientId} = ${oauthClients.clientId}`)
        )
      )
    )
  )
  return {
    calls,
    tokens,
    sealed,
    requests,
    unredeemed,
    clients,
    cutoff: cutoff.toISOString(),
  }
}
