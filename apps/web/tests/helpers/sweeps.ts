/**
 * One lost-runs sweep at a time across test files.
 *
 * `runSweepLostRuns` reads EVERY tenant's stale active runs — the cron is cross-tenant by design —
 * and asks the Workflow binding of the env it was handed what each instance is doing. Test files
 * run in parallel against one database, and each has its own Workflow stub, so a sweep in another
 * file finds this file's backdated rows, asks ITS stub, hears "not found" and fails them with
 * `Workflow instance not found` before this file's own sweep gets to them. Unlike a prune, the
 * outcome depends on who sweeps, so asserting only on our own rows is not enough.
 *
 * Every test that makes a run stale and sweeps holds this lock from the backdate to its last
 * assertion. Another file's sweep test waits; any stale row a test leaves behind is fair game once
 * the lock is released, because its assertions are done. A new file that calls
 * `runSweepLostRuns` on stale rows must use it too.
 */
import { sql } from 'drizzle-orm'
import { it } from 'vitest'
import type { Database } from '@/db/client'

/** Arbitrary, fixed: the advisory lock key every sweep test shares. */
const SWEEP_LOCK = 7_301_455

/** Run `body` holding the cross-file sweep lock (a transaction-scoped advisory lock). */
export async function withSweepLock<T>(db: Database, body: () => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SWEEP_LOCK})`)
    return body()
  })
}

/** `it`, with the body under {@link withSweepLock}. */
export function itSweeps(db: Database, name: string, body: () => Promise<void>) {
  it(name, () => withSweepLock(db, body))
}
