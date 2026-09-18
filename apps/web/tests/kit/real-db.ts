/**
 * The register of database handles the integration harness actually handed out (D31).
 *
 * **This is the whole of the no-fake-`db` rule, and it is deliberately not a shape check.** A
 * structural test ("does it have `.execute`?") is satisfied by `{ execute: vi.fn() }`, which is
 * exactly the object this exists to refuse. Membership of a `WeakSet` populated by
 * `setupTestDatabase()` cannot be forged by writing a convincing literal: the only way in is to have
 * called the harness, which means the test database is up and migrated.
 *
 * Why it matters enough to have its own module: the context builders in `./unit` take `db` as an
 * injected value, and injection is precisely what makes it easy to write a test that LOOKS like an
 * isolation proof and proves nothing — a fake `db` returning `[]` passes "tenant B sees no rows"
 * whatever the query said. A fake context is for branching, guards and response shape. Anything
 * that touches data runs on real Postgres, by construction rather than by review.
 *
 * The accepted cost, stated so nobody rediscovers it as a bug: **there is no fast, database-free
 * test of a handler that touches data.** That is the trade — a slower suite in exchange for an
 * isolation case that cannot be faked into passing.
 */

/**
 * Handles `setupTestDatabase()` returned. A `WeakSet` so a handle closed and forgotten is collected
 * with it; nothing here keeps a connection alive.
 */
const HANDED_OUT = new WeakSet<object>()

/** Called by `tests/helpers/db.ts` as it hands a handle out. Returns its argument, so it chains. */
export function rememberRealDatabase<T>(db: T): T {
  if (typeof db === 'object' && db !== null) HANDED_OUT.add(db as object)
  return db
}

export function isRealDatabase(db: unknown): boolean {
  return typeof db === 'object' && db !== null && HANDED_OUT.has(db as object)
}

/**
 * Refuse anything the harness did not hand out. The message carries the EDIT, like every other
 * diagnostic in the plugin surface: a test author reading this needs the two lines that fix it, not
 * a restatement of the rule.
 */
export function assertRealDatabase(db: unknown, builder: string): void {
  if (isRealDatabase(db)) return
  throw new Error(
    `${builder}({ db }) was given a handle the integration harness did not hand out.\n` +
      '\n' +
      'A context builder will not accept a fake `db`. Injection makes it easy to write a test that\n' +
      'looks like an isolation proof and proves nothing — a stub returning [] passes "tenant B sees\n' +
      'no rows" whatever the query said. A fake context is for branching, guards and response shape;\n' +
      'anything that touches data runs on real Postgres.\n' +
      '\n' +
      'Replace with:\n' +
      "  import { setupTestDatabase } from '@testkit/integration'\n" +
      '  const db = setupTestDatabase()\n' +
      `  const ctx = ${builder}({ db, /* … */ })\n` +
      '\n' +
      '(`pnpm test:db:up` first if the test database is not running.)'
  )
}
