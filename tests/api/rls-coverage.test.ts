/**
 * RLS coverage, catalog-driven (D1): every table with a `tenant_id` column carries a policy, the
 * set of policies in Postgres equals the set the schema declares, the unpolicied tables are exactly
 * `RLS_EXCLUDED_TABLES`, and the revoked tables grant NOTHING to the app role. Runs in `off` mode:
 * the policies exist and are inert (owner connection bypasses them); the role cannot bypass RLS.
 */
import { sql } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from '@/db/schema'
import { APP_ROLE, RLS_EXCLUDED_TABLES, RLS_REVOKED_TABLES } from '@/db/schema/rls'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[]
}

/** `ARRAY['a','b']::text[]` — drizzle renders a JS array parameter as a record, not an array. */
function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map(v => sql`${v}`),
    sql`, `
  )}]::text[]`
}

/** Every table + policy the schema barrel declares. */
function declared() {
  const tables = new Map<string, string[]>()
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue
    const cfg = getTableConfig(value)
    tables.set(
      cfg.name,
      cfg.policies.map(p => p.name)
    )
  }
  return tables
}

describe('row-level security coverage', () => {
  it('declares every public table in the schema barrel', async () => {
    const live = await rows<{ name: string }>(sql`
      SELECT table_name::text AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
    expect(live.map(r => r.name).sort()).toEqual([...declared().keys()].sort())
  })

  it('every table with a tenant_id column has RLS enabled and a policy', async () => {
    const tenantTables = await rows<{ name: string }>(sql`
      SELECT table_name::text AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'`)
    expect(tenantTables.length).toBeGreaterThan(0)
    const policies = await rows<{ tablename: string; policyname: string }>(sql`
      SELECT tablename::text, policyname::text FROM pg_policies WHERE schemaname = 'public'`)
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>(sql`
      SELECT c.relname::text, c.relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`)
    for (const { name } of tenantTables) {
      expect(
        policies.some(p => p.tablename === name),
        `policy on ${name}`
      ).toBe(true)
      expect(rls.find(r => r.relname === name)?.relrowsecurity, `RLS enabled on ${name}`).toBe(true)
    }
  })

  it('the live policy set equals the schema-declared set, and users/tenants are policied', async () => {
    const live = await rows<{ tablename: string; policyname: string; roles: string }>(sql`
      SELECT tablename::text, policyname::text, array_to_string(roles, ',') AS roles
      FROM pg_policies WHERE schemaname = 'public'`)
    const expected = [...declared().values()].flat().sort()
    expect(live.map(p => p.policyname).sort()).toEqual(expected)
    expect(expected).toContain('users_tenant_isolation')
    expect(expected).toContain('tenants_tenant_isolation')
    for (const p of live) expect(p.roles, `${p.policyname} targets ${APP_ROLE}`).toBe(APP_ROLE)
  })

  it('policies use one shared predicate on the tenant GUC', async () => {
    const live = await rows<{ policyname: string; qual: string; with_check: string }>(sql`
      SELECT policyname::text, qual::text, with_check::text FROM pg_policies
      WHERE schemaname = 'public'`)
    for (const p of live) {
      expect(p.qual, p.policyname).toContain("current_setting('app.tenant_id'")
      expect(p.with_check, p.policyname).toContain("current_setting('app.tenant_id'")
      expect(p.qual).toBe(p.with_check)
    }
  })

  it('the unpolicied tables are exactly RLS_EXCLUDED_TABLES', async () => {
    const unpolicied = await rows<{ name: string }>(sql`
      SELECT t.table_name::text AS name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.table_name)`)
    expect(unpolicied.map(r => r.name).sort()).toEqual([...RLS_EXCLUDED_TABLES].sort())
    // Excluded tables have no tenant_id — otherwise they would need a policy.
    const withTenant = await rows<{ name: string }>(sql`
      SELECT table_name::text AS name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
        AND table_name::text = ANY(${textArray(RLS_EXCLUDED_TABLES)})`)
    expect(withTenant).toEqual([])
  })

  it('the revoked infrastructure tables grant nothing to the app role', async () => {
    const grants = await rows<{ table_name: string; privilege_type: string }>(sql`
      SELECT table_name::text, privilege_type::text FROM information_schema.role_table_grants
      WHERE grantee = ${APP_ROLE} AND table_schema = 'public'
        AND table_name::text = ANY(${textArray(RLS_REVOKED_TABLES)})`)
    expect(grants).toEqual([])
    // ...while an ordinary tenant table is granted DML (the blanket grant ran).
    const tenantGrants = await rows<{ privilege_type: string }>(sql`
      SELECT privilege_type::text FROM information_schema.role_table_grants
      WHERE grantee = ${APP_ROLE} AND table_schema = 'public' AND table_name = 'tenant_users'`)
    expect(tenantGrants.map(g => g.privilege_type).sort()).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ])
  })

  it('the app role cannot bypass RLS', async () => {
    const [role] = await rows<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}`)
    expect(role).toBeDefined()
    expect(role?.rolsuper).toBe(false)
    expect(role?.rolbypassrls).toBe(false)
  })
})
