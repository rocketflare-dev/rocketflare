// @vitest-isolate
// Points the neon driver's GLOBAL `neonConfig` at a local relay, so it needs its own module registry.
/**
 * The Neon WebSocket path when the network misbehaves, on the REAL driver against the test
 * Postgres through a WebSocket relay (`helpers/ws-pg-relay.ts`) that refuses or drops connections
 * on cue — what a coding sandbox saw on a Neon gate branch (rocketflare-launch#7):
 *
 * - `createNeonPool` (`src/db/client.ts`): a dropped connection REJECTS the query in flight and is
 *   never an uncaught exception. Without its listeners, pg-pool's `error` on the pool (an idle
 *   client dropped) and a checked-out client's own `error` (a transaction's) are unhandled — the
 *   process dies, which vitest reports as an "Unhandled Error" failing this file.
 * - `waitForDatabase` (`scripts/lib/sql.ts`) rides out connections that fail before Postgres
 *   answers — the driver's message-less `ErrorEvent` — and `applyDbRoles`, the FIRST connection
 *   tests/setup.ts makes, now waits on it too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createNeonPool, routeNeonThroughProxy } from '@/db/client'
import { applyDbRoles } from '../../scripts/db-roles'
import { waitForDatabase } from '../../scripts/lib/sql'
import { type PgRelay, relay } from '../helpers/ws-pg-relay'

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const relays: PgRelay[] = []
afterEach(() => {
  for (const r of relays.splice(0)) r.close()
})

describe('createNeonPool', () => {
  it('a transaction whose connection drops rejects; an idle one that drops is replaced — nothing uncaught', async () => {
    const r = await relay()
    relays.push(r)
    routeNeonThroughProxy(r.url)
    const pool = createNeonPool(process.env.DATABASE_URL ?? '', 1)
    try {
      const client = await pool.connect()
      await client.query('BEGIN')
      r.dropAll()
      await pause(200)
      await expect(client.query('select 1')).rejects.toThrow()
      client.release(true)

      expect((await pool.query('select 2 as two')).rows).toEqual([{ two: 2 }])
      r.dropAll()
      await pause(200)
      expect((await pool.query('select 3 as three')).rows).toEqual([{ three: 3 }])
    } finally {
      await pool.end().catch(() => {})
    }
  }, 30_000)
})

describe('the first connection is retried', () => {
  it('waitForDatabase rides out refused WebSocket connections', async () => {
    const r = await relay(2)
    relays.push(r)
    const env = { DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: r.url }
    await waitForDatabase(process.env.DATABASE_URL ?? '', env, 5)
    expect(r.upgrades()).toBe(3)
  }, 30_000)

  it('…and gives up with a readable error, not an empty ErrorEvent', async () => {
    const r = await relay(1_000)
    relays.push(r)
    const env = { DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: r.url }
    await expect(waitForDatabase(process.env.DATABASE_URL ?? '', env, 2)).rejects.toThrow(
      'Database not ready after 2 attempts: the WebSocket failed before Postgres answered'
    )
  }, 30_000)

  it('applyDbRoles waits for the database before its first statement', async () => {
    const r = await relay(2)
    relays.push(r)
    await expect(
      applyDbRoles({
        databaseUrl: process.env.DATABASE_URL ?? '',
        phase: 'role',
        quiet: true,
        env: { DATABASE_DRIVER: 'neon', NEON_LOCAL_PROXY: r.url },
      })
    ).resolves.toMatchObject({ revoked: [] })
    expect(r.upgrades()).toBeGreaterThanOrEqual(3)
  }, 30_000)
})
