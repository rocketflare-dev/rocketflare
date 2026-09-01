/**
 * Create (or reconcile) the non-superuser Postgres role that RLS policies target (D1).
 * Ported from the Node reference app's `scripts/db-roles.ts` onto postgres.js; role name from
 * `src/db/schema/rls.ts`, REVOKE list from `RLS_REVOKED_TABLES`.
 *
 * The owner (DATABASE_URL's user) owns every table and bypasses RLS — on Neon it is a
 * `neon_superuser` member (BYPASSRLS), locally a real superuser — so policies are inert on that
 * connection by design. `gmgo_app` is the role the policies name: NOSUPERUSER, NOBYPASSRLS,
 * DML only on `public`, and LOGIN only once `APP_DATABASE_URL` supplies a credential.
 *
 * Runs TWICE around migrations because its halves want opposite sides of them:
 *   --phase=role   BEFORE migrate.ts  (`CREATE POLICY ... TO gmgo_app` needs the role to exist)
 *   --phase=grants AFTER  migrate.ts  (REVOKE can only name tables that exist)
 * `all` (default) does both — correct once the tables exist (every environment from its second
 * run onward). Idempotent; one transaction; safe to re-run on every deploy.
 *
 * The role is created even with APP_DATABASE_URL unset — NOLOGIN, no password — because a
 * policy cannot reference a missing role. Unsetting APP_DATABASE_URL later does NOT revoke
 * LOGIN: rollback is `TENANT_SCOPE_MODE=off`, not locking out a connection something may hold.
 */
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { APP_ROLE, RLS_REVOKED_TABLES } from '../src/db/schema/rls'

/** Conservative identifier sanity check before we hand a value to quote_ident. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/

export type DbRolesPhase = 'role' | 'grants' | 'all'

export interface ApplyDbRolesOptions {
  /** Owner connection used to apply the changes (default: DATABASE_URL). */
  databaseUrl?: string
  /** Connection string of the app role (default: APP_DATABASE_URL). Username must equal APP_ROLE. */
  appDatabaseUrl?: string
  phase?: DbRolesPhase
  quiet?: boolean
}

export interface ApplyDbRolesResult {
  /** Did the role gain LOGIN + a password this run? False when APP_DATABASE_URL is unset. */
  loginConfigured: boolean
  /** Tables REVOKEd from the app role in this run (grants phase only). */
  revoked: string[]
}

function parseCredentials(connectionString: string, label: string) {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!username) throw new Error(`${label} must include a username`)
  return { username, password }
}

/** Neon: role DDL must target the direct host, same rule as migrate.ts. */
function directHost(url: string): string {
  return url.includes('.neon.tech') ? url.replace(/-pooler(?=\.[^/]*)/, '') : url
}

export async function applyDbRoles(options: ApplyDbRolesOptions = {}): Promise<ApplyDbRolesResult> {
  const phase = options.phase ?? 'all'
  const wantsRole = phase !== 'grants'
  const wantsGrants = phase !== 'role'
  const log = options.quiet ? () => {} : (s: string) => console.log(s)

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is required')
  const appDatabaseUrl = options.appDatabaseUrl ?? process.env.APP_DATABASE_URL

  let appPassword: string | null = null
  if (appDatabaseUrl) {
    const app = parseCredentials(appDatabaseUrl, 'APP_DATABASE_URL')
    if (app.username !== APP_ROLE) {
      throw new Error(`APP_DATABASE_URL must connect as '${APP_ROLE}', found '${app.username}'`)
    }
    if (!app.password) throw new Error(`APP_DATABASE_URL must include a password for '${APP_ROLE}'`)
    appPassword = app.password
  }

  const owner = parseCredentials(databaseUrl, 'DATABASE_URL').username
  if (!IDENTIFIER_RE.test(owner)) {
    throw new Error(`DATABASE_URL username '${owner}' is not a plain SQL identifier`)
  }

  log(
    `Applying database roles [${phase}] (app role '${APP_ROLE}', owner '${owner}', ` +
      `login ${appPassword ? 'configured' : 'not configured — APP_DATABASE_URL unset'})`
  )

  const sql = postgres(directHost(databaseUrl), { max: 1, onnotice: () => {} })
  try {
    // Identifiers and the password literal cannot be bound as parameters; let Postgres quote them.
    const [quoted] = await sql<
      { role_ident: string; role_lit: string; owner_ident: string; password_lit: string }[]
    >`
      SELECT quote_ident(${APP_ROLE}::text)   AS role_ident,
             quote_literal(${APP_ROLE}::text) AS role_lit,
             quote_ident(${owner}::text)      AS owner_ident,
             quote_literal(${appPassword ?? ''}::text) AS password_lit`
    if (!quoted) throw new Error('Failed to quote role identifiers')
    const { role_ident: role, role_lit: roleLit, owner_ident: ownerIdent } = quoted

    const statements: [label: string, sql: string][] = []

    if (wantsRole) {
      statements.push(
        [
          'create role',
          `DO $do$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${roleLit}) THEN
               CREATE ROLE ${role} NOLOGIN;
             END IF;
           EXCEPTION WHEN duplicate_object THEN NULL;
           END $do$`,
        ],
        [
          'role attributes',
          `ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
        ],
        ['statement_timeout', `ALTER ROLE ${role} SET statement_timeout = '30s'`],
        [
          'idle_in_transaction_session_timeout',
          `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15s'`,
        ],
        ['lock_timeout', `ALTER ROLE ${role} SET lock_timeout = '5s'`],
        ['schema usage', `GRANT USAGE ON SCHEMA public TO ${role}`],
        [
          'default table privileges',
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
        ],
        [
          'default sequence privileges',
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public
             GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
        ]
      )
      // Only ever ADDS login (see header).
      if (appPassword) {
        statements.push([
          'role login credential',
          `ALTER ROLE ${role} LOGIN PASSWORD ${quoted.password_lit}`,
        ])
      }
    }

    let revoked: string[] = []
    if (wantsGrants) {
      const revokeTargets = await sql<{ ident: string; name: string }[]>`
        SELECT quote_ident(table_name::text) AS ident, table_name::text AS name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name::text = ANY(${[...RLS_REVOKED_TABLES]}::text[])
        ORDER BY table_name`
      const [{ count: publicTables }] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`

      statements.push(
        [
          'table grants',
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
        ],
        ['sequence grants', `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`]
      )

      // AFTER the blanket grant, same transaction: the grant re-adds DML on every table, so
      // the revoke has to be the last word.
      if (revokeTargets.length > 0) {
        revoked = revokeTargets.map(r => r.name)
        statements.push([
          'revoke infrastructure tables',
          `REVOKE ALL ON ${revokeTargets.map(r => r.ident).join(', ')} FROM ${role}`,
        ])
      } else if (phase === 'grants' && publicTables > 0) {
        // Tables exist but none of the infrastructure tables do: wrong database, or migrations
        // did not run. The REVOKE silently did nothing — exactly what this phase exists to
        // prevent — so say so rather than reporting success.
        throw new Error(
          `None of the REVOKEd infrastructure tables (${RLS_REVOKED_TABLES.join(', ')}) exist ` +
            `although 'public' has ${publicTables} table(s). Run --phase=grants AFTER migrations.`
        )
      } else if (phase === 'grants') {
        log('   (no tables in public yet — nothing to REVOKE; expected before Phase 1 migrations)')
      }
    }

    await sql.begin(async tx => {
      for (const [label, statement] of statements) {
        await tx.unsafe(statement)
        log(`   • ${label}`)
      }
    })

    const [attrs] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}`
    if (!attrs || attrs.rolsuper || attrs.rolbypassrls) {
      throw new Error(
        `Role '${APP_ROLE}' would bypass RLS (rolsuper=${attrs?.rolsuper}, rolbypassrls=${attrs?.rolbypassrls})`
      )
    }

    log(
      `Role '${APP_ROLE}' ready [${phase}] (nosuperuser, nobypassrls` +
        `${appPassword ? '' : ', nologin — policies resolve but nothing can connect as it'})`
    )
    return { loginConfigured: appPassword !== null, revoked }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** `--phase=role|grants|all` (default `all`). */
function parsePhaseArg(argv: string[]): DbRolesPhase {
  const arg = argv.find(value => value.startsWith('--phase'))
  if (!arg) return 'all'
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : ''
  if (value === 'role' || value === 'grants' || value === 'all') return value
  throw new Error(`Unknown --phase '${value}' (expected role, grants or all)`)
}

async function main() {
  try {
    await applyDbRoles({ phase: parsePhaseArg(process.argv.slice(2)) })
  } catch (error) {
    console.error('Database role setup failed:', error)
    process.exit(1)
  }
}

// Only run as a CLI — tests/setup.ts imports applyDbRoles directly.
const invokedPath = process.argv[1]
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
}
