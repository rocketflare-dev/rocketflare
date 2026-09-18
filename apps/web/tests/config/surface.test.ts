/**
 * The primitive an OBSERVED compatibility check is built on (D31): the kit emits a ledger of what
 * it provides, a plugin's use is derived from its own imports, and the answer is the set difference
 * between them.
 *
 * Why this suite exists in the shape it does: every function here is exercised against FIXTURES as
 * well as against the real repository. An assertion that only runs over what happens to be
 * installed passes trivially the day nothing is — and "the kit with no plugins" is the kit's own
 * default state, so a suite written only against reality would quietly stop meaning anything. The
 * fixtures are what keep it honest; the real-repo cases are what keep it true.
 *
 * The `config` project: no database, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Ledger } from '../../../../scripts/lib/surface.d.mts'
import {
  LEDGER_ENTRIES,
  ledgerEntryOfModule,
  missingFrom,
  moduleImports,
  readLedger,
  resolveSpecifier,
  usesOf,
} from '../../../../scripts/lib/surface.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

// ---- fixtures -----------------------------------------------------------------------------------

const temporary: string[] = []

/** A throwaway repo root with exactly these files, so a walk has something deterministic to find. */
function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rf-surface-'))
  temporary.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

/** A `docs/plugin-api.md` carrying nothing but the ledger — the only part anything reads back. */
const ledgerDoc = (rows: string[]) =>
  ['# The plugin API', '', '## Surface ledger', '', 'Prose nobody parses.', '', '```text']
    .concat(rows, ['```', ''])
    .join('\n')

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

// ---- readLedger ---------------------------------------------------------------------------------

describe('readLedger', () => {
  /**
   * Both row shapes, because the generator emits both and they are one key: a top-level export is
   * `entry :: kind :: name :: sig`, and an expanded interface member is the same line with a kind
   * of `member` and a dotted name. Reading only the first shape would report every context method
   * a plugin calls as missing.
   */
  it('reads a top-level member and an expanded interface member alike', () => {
    const root = fixtureRepo({
      'docs/plugin-api.md': ledgerDoc([
        '@/plugins/api :: function :: requestCtx :: function requestCtx(c: Context): RequestCtx',
        '@/plugins/api :: member :: RequestCtx.guard :: guard(action: Actions): void',
      ]),
    })
    const ledger = readLedger(root) as Ledger
    expect(ledger.size).toBe(2)
    expect(ledger.has('@/plugins/api', 'requestCtx')).toBe(true)
    expect(ledger.has('@/plugins/api', 'RequestCtx.guard')).toBe(true)
    expect(ledger.get('@/plugins/api', 'RequestCtx.guard')).toEqual({
      entry: '@/plugins/api',
      kind: 'member',
      name: 'RequestCtx.guard',
      signature: 'guard(action: Actions): void',
    })
    // Another entry's symbol of the same name is a different member; the key carries the entry.
    expect(ledger.has('@/plugins/api/ui', 'requestCtx')).toBe(false)
  })

  /** A signature may contain the separator itself, so the tail is rejoined rather than dropped. */
  it('keeps a signature that contains the separator', () => {
    const root = fixtureRepo({
      'docs/plugin-api.md': ledgerDoc([
        '@/plugins/api :: type :: Weird :: type Weird = { a :: b } | null',
      ]),
    })
    const ledger = readLedger(root) as Ledger
    expect(ledger.get('@/plugins/api', 'Weird')?.signature).toBe('type Weird = { a :: b } | null')
  })

  /**
   * Null, never a throw, for each of the three ways there can be nothing to read — all of which
   * are real states of somebody's checkout. The caller owns treating null as its own failure;
   * `missingFrom` cannot tell "nothing missing" from "nothing to compare against".
   */
  it('answers null when there is no file, no section, or no fenced block', () => {
    expect(readLedger(fixtureRepo({}))).toBeNull()
    expect(
      readLedger(fixtureRepo({ 'docs/plugin-api.md': '# The plugin API\n\nNo ledger.\n' }))
    ).toBeNull()
    expect(
      readLedger(fixtureRepo({ 'docs/plugin-api.md': '## Surface ledger\n\nProse, no fence.\n' }))
    ).toBeNull()
  })

  it('reads the real ledger, and every entry it names is a declared entry', () => {
    const ledger = readLedger(REPO_ROOT) as Ledger
    expect(ledger).not.toBeNull()
    expect(ledger.size).toBeGreaterThan(400)
    const labels = new Set(LEDGER_ENTRIES.map(e => e.import))
    for (const member of ledger.members.values()) {
      expect(labels.has(member.entry), member.entry).toBe(true)
    }
    // The capability index's own first row, as a canary that the key shape still matches reality.
    expect(ledger.has('@/plugins/api', 'requestCtx')).toBe(true)
    expect(ledger.has('@/plugins/api', 'RequestCtx.guard')).toBe(true)
  })
})

// ---- resolving an import back to an entry -------------------------------------------------------

describe('ledgerEntryOfModule', () => {
  it('matches an entry exactly, never by prefix', () => {
    expect(ledgerEntryOfModule('apps/web/src/plugins/api/index.ts')).toBe('@/plugins/api')
    expect(ledgerEntryOfModule('apps/web/src/plugins/api')).toBe('@/plugins/api')
    // A prefix rule would fold the peers into the barrel and report every peer symbol as missing.
    expect(ledgerEntryOfModule('apps/web/src/plugins/api/peers')).toBe('@/plugins/api/peers')
    expect(ledgerEntryOfModule('apps/web/src/api/services/jobs')).toBeNull()
    expect(ledgerEntryOfModule(null)).toBeNull()
  })

  it('resolves the spellings a plugin actually writes', () => {
    const from = 'apps/web/src/plugins/orders/api/routes.ts'
    expect(ledgerEntryOfModule(resolveSpecifier(from, '@/plugins/api'))).toBe('@/plugins/api')
    expect(
      ledgerEntryOfModule(
        resolveSpecifier('apps/web/src/plugins/orders/db/schema/x.ts', '../../../../db/schema/kit')
      )
    ).toBe('@/db/schema/kit')
    expect(
      ledgerEntryOfModule(resolveSpecifier('apps/cli/src/plugins/orders/index.ts', '../api'))
    ).toBe("'../api' (apps/cli/src/plugins/api.ts)")
    expect(ledgerEntryOfModule(resolveSpecifier(from, 'zod'))).toBeNull()
  })
})

// ---- moduleImports ------------------------------------------------------------------------------

describe('moduleImports', () => {
  /**
   * The shapes that all mean "this file uses that symbol". A regex over them is a check that stops
   * matching without saying so, which is why this is a parse.
   */
  it('reads named, aliased, type-only and re-exported bindings', () => {
    const imports = moduleImports(
      [
        "import { createRouter } from '@/plugins/api'",
        "import type { RequestCtx } from '@/plugins/api'",
        "import { type Database, requestCtx as rc } from '@/plugins/api'",
        "import * as everything from '@/plugins/api/ui'",
        "export { validate } from '@/plugins/api'",
      ].join('\n')
    )
    const names = imports.flatMap(i => i.names)
    expect(names).toEqual(['createRouter', 'RequestCtx', 'Database', 'requestCtx', 'validate'])
    expect(imports[1].typeOnly).toBe(true)
    expect(imports[3]).toMatchObject({ namespace: true, names: [] })
    expect(imports[0].line).toBe(1)
  })
})

// ---- usesOf -------------------------------------------------------------------------------------

describe('usesOf', () => {
  const root = fixtureRepo({
    'apps/web/src/plugins/orders/api/routes.ts': [
      "import { z } from 'zod'",
      "import { createRouter, requestCtx } from '@/plugins/api'",
      "import type { RequestCtx } from '@/plugins/api'",
      "import { ORDERS_ENTITY } from '../shared'",
      "import { allTables } from '@/plugins/api/peers'",
    ].join('\n'),
    'apps/web/src/plugins/orders/shared.ts': "export const ORDERS_ENTITY = 'orders'",
    'apps/web/src/plugins/orders/db/schema/orders.ts':
      "import { tenantIsolation, tenantRef } from '../../../../db/schema/kit'",
    'apps/web/src/plugins/orders/tests/api/orders.test.ts':
      "import { createTestEnv, request } from '@testkit/integration'",
    'apps/cli/src/plugins/orders/index.ts': "import { requireClient } from '../api'",
    'packages/shared/src/plugins/orders/index.ts':
      "import type { SharedPlugin } from '../types'\nimport { paginationQuerySchema } from '../../pagination'",
    // Another plugin entirely: never this one's use.
    'apps/web/src/plugins/billing/api/routes.ts': "import { notify } from '@/plugins/api'",
  })

  it('is derived from the plugin’s own files, tests included', () => {
    expect(usesOf(root, 'orders')).toEqual({
      // Ledger entries first, in ledger order…
      '@/plugins/api': ['createRouter', 'requestCtx', 'RequestCtx'],
      '@/plugins/api/peers': ['allTables'],
      '@/db/schema/kit': ['tenantIsolation', 'tenantRef'],
      "'../api' (apps/cli/src/plugins/api.ts)": ['requireClient'],
      '@testkit/integration': ['createTestEnv', 'request'],
      // …then the declared entries the ledger does not cover, alphabetically. They are RECORDED
      // rather than dropped in the walk; `missingFrom` is what declines to judge them.
      '@rocketflare/shared/pagination': ['paginationQuerySchema'],
      '@rocketflare/shared/plugins/types': ['SharedPlugin'],
    })
  })

  /**
   * A type is part of the surface: removing one breaks a plugin exactly as removing a value does,
   * it just breaks at compile time. So `RequestCtx` above is not an oversight — it is the point.
   */
  it('counts a type-only import', () => {
    expect(usesOf(root, 'orders')['@/plugins/api']).toContain('RequestCtx')
  })

  /**
   * Third-party packages and the plugin's own files are absent: there is no host surface on the
   * other side of either, so there is nothing to compare against. Another plugin's imports are
   * absent for the same reason — `deepImportIssue` is what rules on whether reaching there was
   * allowed at all.
   */
  it('ignores third-party, intra-plugin and cross-plugin imports', () => {
    const uses = usesOf(root, 'orders')
    expect(Object.values(uses).flat()).not.toContain('z')
    expect(Object.values(uses).flat()).not.toContain('ORDERS_ENTITY')
    expect(Object.values(uses).flat()).not.toContain('notify')
  })

  /**
   * **A declared entry that is not ledgered is RECORDED, not dropped.** The whole of
   * `packages/shared/src` is importable while only part of it is ledgered, and keying the walk by
   * ledger entry alone meant a plugin importing `@rocketflare/shared/pagination` measured as using
   * *nothing* — indistinguishable from a plugin that imports nothing at all. Losing the
   * measurement in the walk is the silent drift this machinery exists to remove, so the data is
   * kept here and `missingFrom` owns the policy of which entries the ledger may judge.
   */
  it('records an importable entry the ledger does not cover', () => {
    expect(usesOf(root, 'orders')['@rocketflare/shared/pagination']).toEqual([
      'paginationQuerySchema',
    ])
  })

  it('leaves an unledgered entry out of the DIFF, which is where the policy lives', () => {
    const uses = { '@rocketflare/shared/pagination': ['paginationQuerySchema'] }
    const onlyApi = readLedger(
      fixtureRepo({
        'docs/plugin-api.md': ledgerDoc([
          '@/plugins/api :: function :: requestCtx :: function requestCtx(): RequestCtx',
        ]),
      })
    ) as Ledger
    // The ledger carries no `@rocketflare/shared/pagination` row, so it is not entitled to judge
    // that entry — reporting every symbol under it as missing would be a flood that says nothing.
    expect(missingFrom(uses, onlyApi)).toEqual([])
  })

  it('answers an empty object for a plugin that is not installed', () => {
    expect(usesOf(root, 'nothing-here')).toEqual({})
  })
})

// ---- missingFrom --------------------------------------------------------------------------------

describe('missingFrom', () => {
  const ledger = readLedger(
    fixtureRepo({
      'docs/plugin-api.md': ledgerDoc([
        '@/plugins/api :: function :: requestCtx :: function requestCtx(c: Context): RequestCtx',
        '@/plugins/api :: function :: createRouter :: function createRouter(): Hono',
        '@/plugins/api/ui :: const :: api :: const api: ApiClient',
      ]),
    })
  ) as Ledger

  it('is empty when everything a plugin names is provided', () => {
    expect(missingFrom({ '@/plugins/api': ['requestCtx', 'createRouter'] }, ledger)).toEqual([])
  })

  /** A symbol that exists nowhere: named, with no suggestion invented for it. */
  it('reports a removed symbol with no suggestion', () => {
    expect(missingFrom({ '@/plugins/api': ['withAuthAndDb'] }, ledger)).toEqual([
      { entry: '@/plugins/api', symbol: 'withAuthAndDb', suggestion: null },
    ])
  })

  /**
   * The common case, and the one worth computing: the surface was reorganised rather than cut, so
   * the replacement import is a FACT rather than a guess.
   */
  it('reports a moved symbol with the exact replacement import', () => {
    expect(missingFrom({ '@/plugins/api': ['api'] }, ledger)).toEqual([
      {
        entry: '@/plugins/api',
        symbol: 'api',
        suggestion: "import { api } from '@/plugins/api/ui'",
      },
    ])
  })

  /** Nothing in the set difference can throw — that is the whole reason it replaces a matcher. */
  it('never throws, whatever it is handed', () => {
    expect(missingFrom(null, ledger)).toEqual([])
    expect(missingFrom({}, ledger)).toEqual([])
    expect(missingFrom({ '@/plugins/api': [] }, ledger)).toEqual([])
    // A null ledger yields an empty list: the CALLER owns treating that as its own failure.
    expect(missingFrom({ '@/plugins/api': ['anything'] }, null)).toEqual([])
  })

  /**
   * The live canary. `example-feature` is migrated onto the contract and vendored with the kit, so
   * every symbol it names must be in the ledger this checkout emits — if this fails, either the
   * document is stale or the reference plugin has reached for something the kit no longer provides.
   */
  it('finds nothing missing for the reference plugin against the real ledger', () => {
    const real = readLedger(REPO_ROOT)
    const uses = usesOf(REPO_ROOT, 'example-feature')
    expect(Object.keys(uses).length).toBeGreaterThan(0)
    expect(missingFrom(uses, real)).toEqual([])
  })
})
