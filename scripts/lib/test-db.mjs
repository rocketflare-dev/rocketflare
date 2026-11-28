/**
 * One TEST database per checkout (docs/CONCEPTS.md §4). Every checkout on a machine — the main
 * one, each git worktree, each copy — reaches the same compose Postgres on :5433, and the suite
 * truncates every table when it starts. Sharing one database there meant one checkout's truncate
 * landing in the middle of another's run (lock queues, `deadlock detected`), and one branch's
 * tables failing another branch's `rls-coverage`. So the database the suite uses is named from
 * the checkout: `.env.test`'s database (`rocketflare_test`, renamed with the app) plus a short
 * hash of the checkout's real path, `rocketflare_test_1a2b3c4d`.
 *
 * - `apps/web/vitest.config.ts` (and `pnpm eval`) rewrite `DATABASE_URL` / `APP_DATABASE_URL` to
 *   it before anything connects, so every way of starting vitest lands in the same place.
 * - `tests/setup.ts` creates it on first use (`ensureTestDatabase`), records the checkout path in
 *   `COMMENT ON DATABASE`, then migrates it as before.
 * - `pnpm test:db:prune` drops the ones whose checkout no longer exists.
 *
 * Only a LOCAL URL naming exactly `.env.test`'s database is rewritten: a remote target (a Neon gate
 * branch, `TEST_DATABASE_EPHEMERAL=1`) and a URL someone pointed at another database are used as
 * given.
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root this file belongs to — never the caller's cwd. */
export const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const ENV_TEST_FILE = path.join(CHECKOUT_ROOT, 'apps/web/.env.test')

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
/** `COMMENT ON DATABASE` of a per-checkout database starts with this; prune reads nothing else. */
export const COMMENT_PREFIX = 'rocketflare-test-checkout:'

/**
 * The checkout's path as the filesystem names it: symlinks resolved (`/tmp` → `/private/tmp` on
 * macOS) and, through the native call, its real letter case, so two spellings of one checkout
 * share a database.
 */
export function checkoutPath(root = CHECKOUT_ROOT) {
  try {
    return realpathSync.native(root)
  } catch {
    return path.resolve(root)
  }
}

/** 8 hex characters of SHA-256 over the path's UTF-8 bytes: the same on every Node version. */
export function checkoutHash(realPath) {
  return createHash('sha256').update(String(realPath), 'utf8').digest('hex').slice(0, 8)
}

/** The database `.env.test`'s `DATABASE_URL` names, or null. */
export function envTestDatabaseName(envTestText) {
  const raw = /^DATABASE_URL=(\S+)/m.exec(envTestText ?? '')?.[1]
  if (!raw) return null
  try {
    return decodeURIComponent(new URL(raw).pathname.slice(1)) || null
  } catch {
    return null
  }
}

/** `<base>_<hash>` — `base` is `.env.test`'s database, the hash the checkout's. */
export function checkoutDatabaseName(base, realPath) {
  return `${base}_${checkoutHash(realPath)}`
}

function databaseOf(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1))
  } catch {
    return null
  }
}

/** `url` pointed at `name`, when it is local and names `base`; otherwise `url` unchanged. */
export function rewriteDatabaseUrl(url, base, name) {
  if (!url) return url
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) return url
  if (databaseOf(url) !== base) return url
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * Point `env`'s test URLs at this checkout's database, in place. Returns the database chosen, or
 * null when nothing was rewritten (a remote target, no `.env.test`, a URL naming another database).
 * @param {Record<string, string | undefined>} env
 * @param {{ root?: string, envTestText?: string }} [options]
 */
export function applyCheckoutDatabase(env, options = {}) {
  if (env.TEST_DATABASE_EPHEMERAL === '1' || env.TEST_DATABASE_BRANCH) return null
  let text = options.envTestText
  if (text === undefined) {
    try {
      text = readFileSync(
        options.root ? path.join(options.root, 'apps/web/.env.test') : ENV_TEST_FILE,
        'utf8'
      )
    } catch {
      return null
    }
  }
  const base = envTestDatabaseName(text)
  if (!base) return null
  const realPath = checkoutPath(options.root ?? CHECKOUT_ROOT)
  const name = checkoutDatabaseName(base, realPath)
  // Idempotent: a URL already naming this checkout's database (a child process of a run that
  // rewrote it) counts as chosen.
  const url = rewriteDatabaseUrl(env.DATABASE_URL, base, name)
  if (databaseOf(url) !== name) return null
  env.DATABASE_URL = url
  if (env.APP_DATABASE_URL) {
    env.APP_DATABASE_URL = rewriteDatabaseUrl(env.APP_DATABASE_URL, base, name)
  }
  return { base, name, path: realPath }
}

/** The comment `ensureTestDatabase` writes on a database it creates for a checkout. */
export function checkoutComment(realPath) {
  return `${COMMENT_PREFIX}${realPath}`
}

/** The checkout path in a database comment, or null when the comment is not ours. */
export function parseCheckoutComment(comment) {
  const text = String(comment ?? '')
  return text.startsWith(COMMENT_PREFIX) ? text.slice(COMMENT_PREFIX.length) || null : null
}

/**
 * What `pnpm test:db:prune` keeps and drops: every database carrying our comment, split on whether
 * its checkout path still exists. Databases without the comment — the compose default, anything
 * created by hand or by another tool — are in neither list and never touched.
 * @param {{ name: string, comment: string | null }[]} databases
 * @param {(p: string) => boolean} exists
 */
export function planPrune(databases, exists) {
  const live = []
  const stale = []
  for (const db of databases) {
    const checkout = parseCheckoutComment(db.comment)
    if (!checkout) continue
    ;(exists(checkout) ? live : stale).push({ name: db.name, checkout })
  }
  return { live, stale }
}
