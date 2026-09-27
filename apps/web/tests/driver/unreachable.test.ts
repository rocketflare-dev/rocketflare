/**
 * D35: a database that cannot be reached is a 503 `database_unavailable` under EITHER driver, not
 * a 500. postgres.js reports a code (`ECONNREFUSED`); Neon hides the transport failure under
 * `NeonDbError.sourceError`, and its WebSocket pool fails a transaction with a bare `ErrorEvent`.
 * Probed against a port nothing listens on, through `openDatabase` as the Worker does.
 */
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { classifyInfrastructureError } from '@/api/utils/core/errors'
import { databaseDriver, openDatabase } from '@/db/client'

const DEAD = 'postgresql://nobody:nothing@127.0.0.1:1/nowhere'
const driver = databaseDriver({ DATABASE_DRIVER: process.env.DATABASE_DRIVER })
// Under neon the proxy is the thing the driver dials, so point THAT at the dead port.
const env = {
  DATABASE_DRIVER: driver,
  DATABASE_URL: DEAD,
  NEON_LOCAL_PROXY: driver === 'neon' ? 'http://127.0.0.1:1' : undefined,
}

async function failure(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  throw new Error('expected the query to fail')
}

describe(`an unreachable database under ${driver}`, () => {
  it('a query is classified database_unavailable', async () => {
    const { db, close } = openDatabase(env)
    const error = await failure(() => db.execute(sql`select 1`))
    await close()
    expect(classifyInfrastructureError(error)).toBe('database_unavailable')
  })

  it('a transaction is classified database_unavailable', async () => {
    const { db, close } = openDatabase(env)
    const error = await failure(() => db.transaction(async tx => tx.execute(sql`select 1`)))
    await close()
    expect(classifyInfrastructureError(error)).toBe('database_unavailable')
  })
})
