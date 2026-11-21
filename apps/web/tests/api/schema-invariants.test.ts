/**
 * Schema invariants the migration must carry: the uniqueness rules auth depends on, and
 * `timestamptz` for every `*_at` column (a naive `timestamp` here is a bug the helper exists to
 * prevent). Catalog-driven so a hand-edited migration cannot drift from the schema silently.
 */

import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { rows as resultRows } from '@/db/client'
import { setupTestDatabase } from '../helpers/db'

const db = setupTestDatabase()

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return resultRows<T>(await db.execute(query))
}

describe('schema invariants', () => {
  it('oauth_providers is UNIQUE on (provider, provider_user_id)', async () => {
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
    // pg_catalog, not information_schema: the information_schema join on constraint_name is slow
    // enough (seconds once installed plugins add their tables) to time the test out in CI.
    // Every foreign key carrying `tenant_id` — the single-column one to `tenants` and a composite
    // `(tenant_id, x) → t(tenant_id, id)` alike — must be ON DELETE CASCADE, so `tenant.purge`
    // reaches every row. `confdeltype` is a one-letter code, spelled out here so a failure names
    // the rule a person wrote ('a', NO ACTION, is what a reference with no onDelete gets).
    const fks = await rows<{
      table_name: string
      constraint_name: string
      delete_rule: string
    }>(sql`
      SELECT c.conrelid::regclass::text AS table_name,
             c.conname::text AS constraint_name,
             CASE c.confdeltype
               WHEN 'c' THEN 'CASCADE'
               WHEN 'a' THEN 'NO ACTION'
               WHEN 'r' THEN 'RESTRICT'
               WHEN 'n' THEN 'SET NULL'
               WHEN 'd' THEN 'SET DEFAULT'
               ELSE c.confdeltype::text
             END AS delete_rule
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND n.nspname = 'public' AND a.attname = 'tenant_id'`)
    expect(fks.length).toBeGreaterThan(0)
    for (const fk of fks) {
      expect(
        fk.delete_rule,
        `${fk.table_name} (${fk.constraint_name}) is ON DELETE ${fk.delete_rule}: every foreign ` +
          'key carrying tenant_id must be ON DELETE CASCADE so tenant.purge reaches every row — ' +
          "add { onDelete: 'cascade' } to the reference and run pnpm db:generate"
      ).toBe('CASCADE')
    }

    const ids = await rows<{ table_name: string; data_type: string }>(sql`
      SELECT table_name::text, data_type::text FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'`)
    for (const c of ids) expect(c.data_type, c.table_name).toBe('uuid')
  })
})
