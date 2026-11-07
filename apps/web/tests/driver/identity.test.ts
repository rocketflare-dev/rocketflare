/**
 * The plugin identity seam's multi-step writes (`plugins/api/identity.ts`), under the driver the
 * environment selects — `pnpm test` runs this under both (tests/driver/CLAUDE.md). A sign-in is a
 * user, a provider link, an `idp` membership and a session; a deprovision deletes sessions and then
 * removes the membership inside `db.transaction(…)` (the WebSocket pool under `neon`). Each must
 * leave the same rows under `postgres` and `neon`.
 *
 * Everything goes through `openDatabase`, the Worker's own path. The plugin id is a probe of this
 * file's own, not an installed plugin's: the seam takes any well-formed id, and this suite ships
 * to copies that have removed the example plugin.
 */
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { PinoLogger } from 'hono-pino'
import { afterAll, describe, expect, it } from 'vitest'
import type { AppEnv } from '@/api/types'
import { createLogger } from '@/api/utils/core/logger'
import { loadConfig } from '@/config'
import { type DatabaseEnv, type DatabaseHandle, databaseDriver, openDatabase } from '@/db/client'
import { oauthProviders, tenantUsers, userSessions } from '@/db/schema'
import { identityFor, type PluginSignInInput, provisionFor } from '@/plugins/api/identity'
import { createTestSession, createTestTenant, uniqueId } from '../helpers/auth'
import { setupTestDatabase, testDatabaseUrl } from '../helpers/db'
import { createTestEnv } from '../mocks/bindings'

const env: DatabaseEnv = {
  DATABASE_DRIVER: process.env.DATABASE_DRIVER,
  NEON_LOCAL_PROXY: process.env.NEON_LOCAL_PROXY,
  DATABASE_URL: testDatabaseUrl(),
}
const driver = databaseDriver(env)
const fixtures = setupTestDatabase()
const workerEnv = createTestEnv()
const config = loadConfig(workerEnv)
const logger = createLogger({ level: 'silent' })
const PLUGIN = 'driver-probe'

const handles: DatabaseHandle[] = []
function open(): DatabaseHandle {
  const handle = openDatabase(env)
  handles.push(handle)
  return handle
}
afterAll(async () => {
  await Promise.all(handles.map(h => h.close()))
})

/** `identityFor(c, …).signIn` behind a one-route app, so it gets a real Hono context. */
async function signIn(db: DatabaseHandle['db'], input: PluginSignInInput) {
  const app = new Hono<AppEnv>()
  app.get('/sign-in', c => {
    c.set('db', db)
    c.set('config', config)
    c.set('logger', new PinoLogger(logger))
    return identityFor(c, PLUGIN).signIn(input)
  })
  return app.request('/sign-in', {}, workerEnv)
}

function email() {
  return `driver_${uniqueId().toLowerCase()}@example.test`
}

describe(`identity seam: ${driver}`, () => {
  it('signIn of a new person into a tenant writes user, link, idp membership and pinned session', async () => {
    const { db } = open()
    const tenant = await createTestTenant(fixtures)
    const address = email()
    const res = await signIn(db, {
      subject: `probe|${address}`,
      email: address,
      emailVerified: true,
      tenantId: tenant.id,
      role: 'member',
      redirectTo: '/settings',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/settings')
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__Host-session=[^;]+;/)

    const found = await provisionFor({ db, config, logger, env: workerEnv }, PLUGIN).findUser({
      subject: `probe|${address}`,
    })
    expect(found).toMatchObject({ email: address, emailVerified: true, blocked: false })
    const userId = found?.id ?? ''
    expect(
      await db
        .select({ provider: oauthProviders.provider, subject: oauthProviders.providerUserId })
        .from(oauthProviders)
        .where(eq(oauthProviders.userId, userId))
    ).toEqual([{ provider: `plugin:${PLUGIN}`, subject: `probe|${address}` }])
    expect(
      await db
        .select({ role: tenantUsers.role, source: tenantUsers.source })
        .from(tenantUsers)
        .where(eq(tenantUsers.userId, userId))
    ).toEqual([{ role: 'member', source: 'idp' }])
    expect(
      await db
        .select({ selected: userSessions.selectedTenantId })
        .from(userSessions)
        .where(eq(userSessions.userId, userId))
    ).toEqual([{ selected: tenant.id }])
  })

  it('provision: upsertUser → setMembership → deprovision, and a repeat changes nothing', async () => {
    const { db } = open()
    const provision = provisionFor({ db, config, logger, env: workerEnv }, PLUGIN)
    const [here, there] = await Promise.all([
      createTestTenant(fixtures),
      createTestTenant(fixtures),
    ])
    const address = email()
    const person = await provision.upsertUser({
      subject: `probe|${address}`,
      email: address,
      name: 'Driver Probe',
      emailVerified: true,
    })
    expect(person).toMatchObject({ email: address, name: 'Driver Probe', blocked: false })
    expect(
      await provision.setMembership({ tenantId: here.id, userId: person.id, role: 'admin' })
    ).toEqual({ role: 'admin', source: 'idp' })
    expect(
      await provision.setMembership({ tenantId: there.id, userId: person.id, role: 'member' })
    ).toEqual({ role: 'member', source: 'idp' })
    await createTestSession(fixtures, person.id, here.id)
    await createTestSession(fixtures, person.id, there.id)

    expect(await provision.deprovision({ tenantId: here.id, userId: person.id })).toEqual({
      removed: true,
      sessionsEnded: 1,
      retained: null,
    })
    expect(await provision.deprovision({ tenantId: here.id, userId: person.id })).toEqual({
      removed: false,
      sessionsEnded: 0,
      retained: null,
    })
    expect(
      await db
        .select({ tenantId: tenantUsers.tenantId })
        .from(tenantUsers)
        .where(eq(tenantUsers.userId, person.id))
    ).toEqual([{ tenantId: there.id }])
    expect(
      await db
        .select({ selected: userSessions.selectedTenantId })
        .from(userSessions)
        .where(eq(userSessions.userId, person.id))
    ).toEqual([{ selected: there.id }])
    expect(await provision.findUser({ email: address })).toMatchObject({ blocked: false })
  })
})
