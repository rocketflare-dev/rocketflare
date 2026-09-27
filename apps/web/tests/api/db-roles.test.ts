/**
 * `scripts/db-roles.ts` as a NON-superuser owner — the shape of Neon's `neondb_owner` (CREATEDB,
 * CREATEROLE, no SUPERUSER). Only a superuser may name SUPERUSER / BYPASSRLS / REPLICATION in an
 * ALTER ROLE, even to turn them off, so the role phase must skip those there and still leave the
 * app role unable to bypass RLS. Locally the test owner is a real superuser, which is why this
 * needs its own throwaway owner role to catch a regression.
 */
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_ROLE } from '@/db/schema/rls'
import { applyDbRoles } from '../../scripts/db-roles'
import { testDatabaseUrl } from '../helpers/db'

const ownerRole = `rf_neon_owner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const ownerPassword = 'neon_owner_test'

const superuser = postgres(testDatabaseUrl(), { max: 1, onnotice: () => {} })

function ownerUrl(): string {
  const url = new URL(testDatabaseUrl())
  url.username = ownerRole
  url.password = ownerPassword
  return url.toString()
}

describe('db-roles as a non-superuser owner (Neon)', () => {
  beforeAll(async () => {
    await superuser.unsafe(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER CREATEDB CREATEROLE`
    )
    // On Neon the owner created the app role, which gives it ADMIN OPTION (PG16+); here the
    // superuser created it in globalSetup, so hand that over explicitly.
    await superuser.unsafe(`GRANT ${APP_ROLE} TO ${ownerRole} WITH ADMIN OPTION`)
    await superuser.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${ownerRole} WITH GRANT OPTION`)
  })

  afterAll(async () => {
    await superuser.unsafe(`DROP OWNED BY ${ownerRole}`)
    await superuser.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`)
    await superuser.end({ timeout: 5 })
  })

  it('the throwaway owner really is not a superuser', async () => {
    const [row] = await superuser<{ rolsuper: boolean; rolcreaterole: boolean }[]>`
      SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = ${ownerRole}`
    expect(row).toEqual({ rolsuper: false, rolcreaterole: true })
  })

  it('runs the role phase and leaves the app role unable to bypass RLS', async () => {
    await expect(
      applyDbRoles({ databaseUrl: ownerUrl(), phase: 'role', quiet: true })
    ).resolves.toMatchObject({ revoked: [] })

    const [attrs] = await superuser<
      {
        rolsuper: boolean
        rolbypassrls: boolean
        rolcreatedb: boolean
        rolcreaterole: boolean
        rolreplication: boolean
      }[]
    >`
      SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
      FROM pg_roles WHERE rolname = ${APP_ROLE}`
    expect(attrs).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    })
  })
})
