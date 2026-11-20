/**
 * The MCP server's nightly retention, one DELETE per table across every tenant (like the span
 * prune): calls older than `MCP_CALL_RETENTION_DAYS`, and tokens past their own expiry — an
 * expired token can never be presented again, so keeping its hash buys nothing. Grants are kept,
 * revoked or lapsed, so the admin's list still says who connected what and when it ended.
 */
import { lt } from 'drizzle-orm'
import { affected, type Database } from '../../../db/client'
import { mcpTokens, mcpToolCalls } from '../../../db/schema'

export async function runPruneMcp(db: Database, retentionDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000)
  const calls = affected(await db.delete(mcpToolCalls).where(lt(mcpToolCalls.createdAt, cutoff)))
  const tokens = affected(await db.delete(mcpTokens).where(lt(mcpTokens.expiresAt, now)))
  return { calls, tokens, cutoff: cutoff.toISOString() }
}
