/**
 * Schema invariants the migration must carry (D1, D12): the uniqueness rules auth depends on, and
 * `timestamptz` for every `*_at` column (a naive `timestamp` here is a bug the helper exists to
 * prevent). Catalog-driven so a hand-edited migration cannot drift from the schema silently.
 */
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[]
}

describe('schema invariants', () => {
  it('oauth_providers is UNIQUE on (provider, provider_user_id) — D12', async () => {
    const constraints = await rows<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.oauth_providers'::regclass AND contype = 'u'`)
    expect(constraints.map(c => c.def)).toContain('UNIQUE (provider, provider_user_id)')
  })

  it('team_invitations has ONE pending invitation per (tenant, lower(email))', async () => {
    const [idx] = await rows<{ def: string }>(sql`
      SELECT indexdef AS def FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'team_invitations_pending_email_idx'`)
    expect(idx?.def).toMatch(/^CREATE UNIQUE INDEX/)
    expect(idx?.def).toContain('tenant_id, lower(email)')
    expect(idx?.def).toMatch(/WHERE \(\(accepted_at IS NULL\) AND \(revoked_at IS NULL\)\)/)
  })

  it('users.email is unique case-insensitively', async () => {
    const [idx] = await rows<{ def: string }>(sql`
      SELECT indexdef AS def FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'users_email_lower_idx'`)
    expect(idx?.def).toMatch(/^CREATE UNIQUE INDEX .* \(lower\(email\)\)$/)
  })

  it('credential hashes are unique (sessions, magic links, invitations, API keys)', async () => {
    const constraints = await rows<{ table: string; def: string }>(sql`
      SELECT conrelid::regclass::text AS "table", pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE contype = 'u' AND connamespace = 'public'::regnamespace`)
    const uniques = new Set(constraints.map(c => `${c.table}:${c.def}`))
    for (const [table, column] of [
      ['user_sessions', 'token_hash'],
      ['magic_link_tokens', 'token_hash'],
      ['team_invitations', 'token_hash'],
      ['api_keys', 'key_hash'],
      ['tenants', 'slug'],
    ]) {
      expect(uniques.has(`${table}:UNIQUE (${column})`), `${table}.${column}`).toBe(true)
    }
  })

  it('every *_at column is timestamptz and there is no naive timestamp anywhere', async () => {
    const cols = await rows<{ table_name: string; column_name: string; data_type: string }>(sql`
      SELECT table_name::text, column_name::text, data_type::text FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (column_name LIKE '%\\_at' OR data_type LIKE 'timestamp%')`)
    expect(cols.length).toBeGreaterThan(20)
    for (const c of cols) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('timestamp with time zone')
    }
  })

  it('every tenant-owned table cascades from tenants and has uuid ids', async () => {
    const fks = await rows<{ table_name: string; delete_rule: string }>(sql`
      SELECT tc.table_name::text, rc.delete_rule::text
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        AND kcu.column_name = 'tenant_id'`)
    expect(fks.length).toBeGreaterThan(0)
    for (const fk of fks) expect(fk.delete_rule, fk.table_name).toBe('CASCADE')

    const ids = await rows<{ table_name: string; data_type: string }>(sql`
      SELECT table_name::text, data_type::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'`)
    for (const c of ids) expect(c.data_type, c.table_name).toBe('uuid')
  })
})
