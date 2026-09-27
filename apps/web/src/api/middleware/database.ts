/**
 * Per-request database client (D35): `openDatabase({ ...config, HYPERDRIVE })`, `c.set('db')`,
 * and the client is ended in `executionCtx.waitUntil` AFTER the response — Hyperdrive or Neon is
 * the pool, so nothing is kept across requests. `finally`, not post-`next()`: a throwing handler
 * must not leak a socket.
 *
 * Test mechanism (no hooks in src/): tests call `app.request(path, init, env, ctx)` with a real
 * `ExecutionContext` mock (tests/mocks/bindings.ts) whose `waitUntil` collects promises, and
 * `tests/helpers/request.ts` awaits them — the production close path runs verbatim. If no
 * ExecutionContext is available (Hono's `executionCtx` getter throws) the close is awaited inline.
 *
 * Runs on ASSETS paths too, deliberately unconditional: neither driver connects until the first
 * query, so a request that never queries costs nothing and `close()` is a no-op.
 */
import { createMiddleware } from 'hono/factory'
import { openDatabase } from '../../db/client'
import type { AppContext, AppEnv } from '../types'

/** `ctx.waitUntil(p)` when we have an ExecutionContext, otherwise await it. */
export async function deferOrAwait(c: AppContext, work: () => Promise<unknown>): Promise<void> {
  let ctx: Pick<ExecutionContext, 'waitUntil'> | undefined
  try {
    ctx = c.executionCtx
  } catch {
    ctx = undefined
  }
  if (ctx) ctx.waitUntil(work())
  else await work()
}

export const databaseMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const cfg = c.get('config')
  const handle = openDatabase({ ...cfg, HYPERDRIVE: c.env.HYPERDRIVE })
  c.set('db', handle.db)
  c.set('dbClose', handle.close)
  try {
    await next()
  } finally {
    await deferOrAwait(c, handle.close)
  }
})
