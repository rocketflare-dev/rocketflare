/**
 * The cross-tenant allow-list (D1). The invariant in `.claude/rules/database.md`: every domain query
 * filters by `tenantId` from the auth context. This test pins the exceptions, so a new one is a
 * deliberate edit here rather than something that arrives with a feature.
 *
 * What it proves, exactly: no source file queries a table that HAS a `tenant_id` column from inside
 * a function that never mentions a tenant at all. That is narrower than "only these files are
 * cross-tenant" — `routes/admin.ts` does not appear below because its queries DO name a tenant, the
 * one from the URL rather than the session; `globalAdminMiddleware` is what makes that safe, and no
 * static check replaces reading it.
 *
 * How it reads the source: every table with a `tenant_id` column is found from the drizzle schema
 * itself (no hand-kept list), then each `.ts` under `src/` is parsed and every drizzle query naming
 * one of those tables — `.from(t)`, `.insert(t)`, `.update(t)`, `.delete(t)`, `db.query.t.…` — is
 * checked for a tenant predicate anywhere in its enclosing statement.
 *
 * Its limit, stated plainly because the docs once claimed a coverage this file did not have: the
 * unit is the enclosing FUNCTION, so a handler that mentions the tenant in one query and forgets it
 * in a second reads as scoped. It catches the realistic mistake — a route that queries a tenant
 * table and never mentions the tenant at all — not a determined author. `rls-coverage.test.ts` is
 * the other half: every tenant table carries a policy, for the day RLS is enforced.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as schema from '@/db/schema'
import { sourceFiles, WEB_ROOT } from '../helpers/source-files'

/**
 * Files with a query on a tenant table inside a function that never names a tenant, and why each
 * is correct. Adding an entry is a design decision — say so in the PR; it is not a refactor.
 */
const UNSCOPED_ALLOWLIST: Record<string, string> = {
  'src/api/auth/api-keys.ts':
    'touchApiKeyUsage stamps last_used_at by primary key on a key that has already authenticated (and which carries its own tenantId)',
  'src/api/services/auth.ts':
    'the pre-tenant login path: hasPendingInvitation looks an invitation up by email before any membership exists, and membershipCount counts a user across every tenant — that is the "has no memberships" gate',
  'src/api/services/storage.ts':
    'deleteStoredFile removes a row by primary key that its caller already resolved under the tenant predicate',
  'src/api/services/invitations.ts':
    'pruneInvitations is the nightly cron: expired invitations are deleted across every tenant, which is the job',
}

/** Anything in an enclosing statement that shows the query knows about a tenant. */
const SCOPED = /tenantId|tenant_id|tenantIdOf|withTenantScope|TENANT_ID/

/** Table export name → true, for every table carrying a `tenant_id` column. */
function tenantTableNames(): Set<string> {
  const names = new Set<string>()
  for (const [exportName, value] of Object.entries(schema)) {
    if (!(value instanceof PgTable)) continue
    if (getTableConfig(value).columns.some(c => c.name === 'tenant_id')) names.add(exportName)
  }
  return names
}

interface Finding {
  file: string
  table: string
  line: number
}

/** Every drizzle query on a tenant table whose enclosing statement never mentions the tenant. */
function unscopedQueries(tables: Set<string>): Finding[] {
  const found: Finding[] = []
  for (const rel of sourceFiles()) {
    const text = readFileSync(path.join(WEB_ROOT, rel), 'utf8')
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)

    const visit = (node: ts.Node): void => {
      const table = queriedTable(node, tables)
      if (table) {
        if (!SCOPED.test(scopeOf(node).getText(sf))) {
          found.push({
            file: rel,
            table,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return found
}

/**
 * The text a tenant predicate may live in: the enclosing FUNCTION, not the statement. Routes
 * routinely build `const where = eq(t.tenantId, tenantId)` and pass it to `.where(where)` a line
 * later, so a statement-level unit reports every one of those as a leak. The function is the unit
 * the invariant is actually written in — "this handler knows which tenant it is serving".
 */
function scopeOf(node: ts.Node): ts.Node {
  let current: ts.Node = node
  while (current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return current
    }
    current = current.parent
  }
  return current
}

/** The tenant table this node queries, if it is a drizzle query at all. */
function queriedTable(node: ts.Node, tables: Set<string>): string | null {
  // db.select().from(t) · db.insert(t) · db.update(t) · db.delete(t)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text
    const arg = node.arguments[0]
    if (
      /^(from|insert|update|delete)$/.test(method) &&
      arg &&
      ts.isIdentifier(arg) &&
      tables.has(arg.text)
    ) {
      return arg.text
    }
  }
  // db.query.<table>.findFirst / findMany
  if (ts.isPropertyAccessExpression(node) && tables.has(node.name.text)) {
    const parent = node.expression
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'query') return node.name.text
  }
  return null
}

describe('cross-tenant query allow-list', () => {
  const tables = tenantTableNames()

  it('finds the tenant tables from the schema, not a hand-kept list', () => {
    expect(tables.size).toBeGreaterThan(10)
    expect(tables).toContain('activityEvents')
    expect(tables).toContain('files')
    // `users` is global — a person belongs to many tenants — so it must NOT be in here.
    expect(tables).not.toContain('users')
  })

  it('reads real source: every allow-listed file exists and every path is relative to apps/web', () => {
    const all = new Set(sourceFiles())
    expect(all.size).toBeGreaterThan(50)
    for (const file of Object.keys(UNSCOPED_ALLOWLIST)) {
      expect(all.has(file), `${file} (allow-listed) is a source file`).toBe(true)
    }
  })

  it('only the allow-listed files query a tenant table without naming the tenant', () => {
    const findings = unscopedQueries(tables)
    const offenders = [...new Set(findings.map(f => f.file))].sort()
    const allowed = Object.keys(UNSCOPED_ALLOWLIST).sort()

    // The message is the point of this test: it has to say what to do about a new entry.
    const detail = findings
      .filter(f => !(f.file in UNSCOPED_ALLOWLIST))
      .map(f => `  ${f.file}:${f.line} queries ${f.table} with no tenant predicate`)
      .join('\n')
    expect(
      offenders.filter(f => !(f in UNSCOPED_ALLOWLIST)),
      `A query on a tenant table must filter by tenantId from the auth context.\n${detail}\n` +
        'If it is genuinely cross-tenant, that is a design decision: add the file to ' +
        'UNSCOPED_ALLOWLIST in this test WITH A REASON, and say so in the PR.'
    ).toEqual([])

    // The other direction: an entry that no longer needs to be here is removed, so the list
    // stays a true statement about the code rather than a historical one.
    expect(
      allowed.filter(f => !offenders.includes(f)),
      'These files no longer query a tenant table unscoped — drop them from UNSCOPED_ALLOWLIST.'
    ).toEqual([])
  })
})
