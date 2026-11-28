/**
 * The plugin surface the kit publishes (#182): the parser that measures it, the two files it is
 * written to, the reader that prefers the JSON and falls back to the Markdown, and the hand-written
 * "What you want to do" index in the `rf-plugin` reference, whose every name must exist.
 *
 * **The parser is proved against the type checker it replaced.** The surface used to be extracted
 * with TypeScript's checker (`typescript6`); it is extracted with `oxc-parser` now, which follows
 * re-exports by syntax alone. The first test runs both over the real declared entries and demands
 * the same set of `entry :: kind :: name` rows — so a barrel shape the parser misreads (a default
 * re-export, an `export *`, a merged declaration) fails here by name rather than silently dropping a
 * member from every plugin's compatibility check. It goes when `typescript6` does.
 *
 * Kit-only: the surface is the kit's published API, and a copy publishes none.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript6'
import { afterAll, describe, expect, it } from 'vitest'
import { createExportReader } from '../../../../scripts/lib/module-exports.mjs'
import {
  expands,
  readDeclaredSurface,
  renderSurfaceJson,
} from '../../../../scripts/lib/plugin-surface.mjs'
import type { Ledger } from '../../../../scripts/lib/surface.d.mts'
import {
  LEDGER_ENTRIES,
  ledgerEntryOfModule,
  missingFrom,
  readLedger,
  readMarkdownLedger,
  readSurfaceJson,
  resolveSpecifier,
  SURFACE_ALIASES,
} from '../../../../scripts/lib/surface.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const temporary: string[] = []

function fixtureRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rf-plugin-surface-'))
  temporary.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true })
})

const rowsOf = (ledger: Ledger | null) =>
  new Set([...(ledger?.members.values() ?? [])].map(m => `${m.entry} :: ${m.kind} :: ${m.name}`))

// ---- the type checker's answer, as the generator before #182 computed it -------------------------

/** The kind word the old generator gave a declaration (`describe` in its `plugin-api-doc.mjs`). */
function checkerKind(d: ts.Declaration): string {
  if (ts.isInterfaceDeclaration(d)) return 'interface'
  if (ts.isTypeAliasDeclaration(d)) return 'type'
  if (ts.isClassDeclaration(d) && d.name) return 'class'
  if (ts.isFunctionDeclaration(d) && d.name) return 'function'
  if (ts.isEnumDeclaration(d)) return 'enum'
  if (ts.isVariableDeclaration(d)) return 'const'
  return 'value'
}

function checkerRows(): Set<string> {
  const files = LEDGER_ENTRIES.map(e => path.join(REPO_ROOT, e.file))
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    noEmit: true,
    noResolve: false,
    baseUrl: path.join(REPO_ROOT, 'apps/web'),
    paths: { '@/*': ['src/*'], '@testkit/*': ['tests/kit/*'] },
    types: [],
  })
  const checker = program.getTypeChecker()
  const rows = new Set<string>()
  for (const entry of LEDGER_ENTRIES) {
    const source = program.getSourceFile(path.join(REPO_ROOT, entry.file))
    const moduleSymbol = source && checker.getSymbolAtLocation(source)
    if (!moduleSymbol) throw new Error(`no module symbol: ${entry.file}`)
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
      const declaration = symbol.declarations?.[0]
      if (!declaration) continue
      const name = exported.getName()
      rows.add(`${entry.import} :: ${checkerKind(declaration)} :: ${name}`)
      if (!expands(name) || !ts.isInterfaceDeclaration(declaration)) continue
      for (const m of declaration.members) {
        if (!(m.name || ts.isCallSignatureDeclaration(m) || ts.isIndexSignatureDeclaration(m)))
          continue
        rows.add(`${entry.import} :: member :: ${name}.${m.name ? m.name.getText() : '()'}`)
      }
    }
  }
  return rows
}

describe('the parser', () => {
  it('lists every declared entry exactly as the type checker does', { timeout: 60_000 }, () => {
    const parsed = new Set(
      readDeclaredSurface(REPO_ROOT).members.map(m => `${m.entry} :: ${m.kind} :: ${m.name}`)
    )
    const checked = checkerRows()
    expect(checked.size).toBeGreaterThan(400)
    expect(
      [...parsed].filter(row => !checked.has(row)),
      'only the parser has'
    ).toEqual([])
    expect(
      [...checked].filter(row => !parsed.has(row)),
      'only the checker has'
    ).toEqual([])
  })

  /**
   * The barrel shapes the declared entries use, each in one fixture, so a regression names the
   * shape rather than a member of a 700-line surface.
   */
  it('follows each re-export shape to its declaration', () => {
    const root = fixtureRepo({
      'src/barrel.ts': [
        "export { a, type B } from './a'",
        "export { default as Widget } from './widget'",
        "export * from './star'",
        "export * as ns from './a'",
        "import { c } from './a'",
        'export { c }',
        'export const local = 1, other = 2',
        'export interface Merged { x: 1 }',
        'export const Merged = {}',
        'export declare function over(a: string): void',
        "export { z } from 'zod'",
      ].join('\n'),
      'src/a.ts': ['export function a() {}', 'export type B = string', 'export class c {}'].join(
        '\n'
      ),
      'src/widget.tsx': 'export default function Widget() { return null }',
      'src/star.ts': [
        "export { deep } from './deeper'",
        'export const fromStar = 1',
        'export default 1',
      ].join('\n'),
      'src/deeper.ts': [
        'export interface deep { one: 1; "two-x": 2; three(): void; three(a: 1): void; (): void; [k: string]: unknown; new (): deep }',
      ].join('\n'),
    })
    const reader = createExportReader({
      repoRoot: root,
      resolve: (importer, specifier) =>
        specifier.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
          : null,
    })
    const got = Object.fromEntries(
      reader.exportsOf('src/barrel.ts').map(e => [e.name, [e.kind, e.members.join(',')]])
    )
    expect(got).toEqual({
      a: ['function', ''],
      B: ['type', ''],
      c: ['class', ''],
      deep: ['interface', 'one,"two-x",three,()'],
      fromStar: ['const', ''],
      local: ['const', ''],
      Merged: ['interface', 'x'],
      ns: ['value', ''],
      other: ['const', ''],
      over: ['function', ''],
      Widget: ['function', ''],
      z: ['external', ''],
    })
  })

  it('throws naming the file when a re-export does not resolve', () => {
    const root = fixtureRepo({ 'src/x.ts': "export { gone } from './y'", 'src/y.ts': '' })
    const reader = createExportReader({
      repoRoot: root,
      resolve: (importer, specifier) => path.posix.join(path.posix.dirname(importer), specifier),
    })
    expect(() => reader.exportsOf('src/x.ts')).toThrow(/src\/x\.ts: 'gone' is not exported/)
  })
})

// ---- the two files ------------------------------------------------------------------------------

describe('docs/plugin-surface.json and the Markdown ledger', () => {
  it('is what the generator writes from this checkout', () => {
    const committed = readFileSync(path.join(REPO_ROOT, 'docs/plugin-surface.json'), 'utf8')
    expect(committed).toBe(renderSurfaceJson(readDeclaredSurface(REPO_ROOT)))
  })

  /** Both are read by somebody — the JSON by this kit, the Markdown by vendored readers. */
  it('carries exactly the same members as the Markdown ledger', () => {
    const json = readSurfaceJson(REPO_ROOT)
    const markdown = readMarkdownLedger(REPO_ROOT)
    expect(json?.size).toBeGreaterThan(400)
    expect(rowsOf(json)).toEqual(rowsOf(markdown))
  })

  it('records the moved-symbol map and the @rf alias', () => {
    const surface = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'docs/plugin-surface.json'), 'utf8')
    )
    expect(surface.aliases).toEqual(SURFACE_ALIASES)
    expect(surface.aliases['@rf/*']).toBe('@/plugins/api/*')
    expect(surface.moved.requestCtx).toEqual(['@/plugins/api'])
    // A name two entries both provide lists both, in ledger order.
    expect(surface.moved.CliPlugin).toEqual([
      "'../api' (apps/cli/src/plugins/api.ts)",
      "'./types' (apps/cli/src/plugins/types.ts)",
    ])
  })
})

// ---- readLedger: the JSON first, the Markdown as the fallback ------------------------------------

describe('readLedger', () => {
  const json = (members: Array<{ entry: string; kind: string; name: string }>) =>
    JSON.stringify({ schemaVersion: 1, aliases: {}, entries: [], members, moved: {} })
  const markdown = (rows: string[]) =>
    ['## Surface ledger', '', '```text', ...rows, '```', ''].join('\n')

  it('reads the JSON when the host has it, and prefers it to the Markdown', () => {
    const root = fixtureRepo({
      'docs/plugin-surface.json': json([
        { entry: '@/plugins/api', kind: 'function', name: 'requestCtx' },
      ]),
      'docs/plugin-api.md': markdown(['@/plugins/api :: function :: legacyOnly :: -']),
    })
    const ledger = readLedger(root) as Ledger
    expect(ledger.source).toBe('json')
    expect(ledger.has('@/plugins/api', 'requestCtx')).toBe(true)
    expect(ledger.has('@/plugins/api', 'legacyOnly')).toBe(false)
  })

  /** A copy on an older kit has only the Markdown; that is the transition this keeps working. */
  it('falls back to the Markdown when there is no JSON, or the JSON is not a surface', () => {
    const md = markdown(['@/plugins/api :: function :: requestCtx :: function requestCtx(): X'])
    const cases: Record<string, string>[] = [
      { 'docs/plugin-api.md': md },
      { 'docs/plugin-api.md': md, 'docs/plugin-surface.json': '{ not json' },
      { 'docs/plugin-api.md': md, 'docs/plugin-surface.json': '{"schemaVersion": 99}' },
      {
        'docs/plugin-api.md': md,
        'docs/plugin-surface.json': '{"schemaVersion": 1, "members": [{}]}',
      },
    ]
    for (const files of cases) {
      const ledger = readLedger(fixtureRepo(files)) as Ledger
      expect(ledger.source).toBe('markdown')
      expect(ledger.has('@/plugins/api', 'requestCtx')).toBe(true)
    }
    expect(readLedger(fixtureRepo({ 'docs/plugin-surface.json': '{ not json' }))).toBeNull()
  })

  it('reads the real surface from the JSON, with the same moved-symbol answers', () => {
    const ledger = readLedger(REPO_ROOT) as Ledger
    expect(ledger.source).toBe('json')
    expect(missingFrom({ '@/plugins/api': ['api'] }, ledger)).toEqual([
      {
        entry: '@/plugins/api',
        symbol: 'api',
        suggestion: "import { api } from '@/plugins/api/ui'",
      },
    ])
    const fromMarkdown = readMarkdownLedger(REPO_ROOT)
    expect(missingFrom({ '@/plugins/api': ['api'] }, fromMarkdown)).toEqual(
      missingFrom({ '@/plugins/api': ['api'] }, ledger)
    )
  })
})

// ---- the alias ----------------------------------------------------------------------------------

describe('@rf/* — a second name for @/plugins/api/*', () => {
  it('resolves to the entry the name it stands for resolves to', () => {
    const from = 'apps/web/src/sales/api/routes.ts'
    expect(ledgerEntryOfModule(resolveSpecifier(from, '@rf'))).toBe('@/plugins/api')
    expect(ledgerEntryOfModule(resolveSpecifier(from, '@rf/peers'))).toBe('@/plugins/api/peers')
    expect(ledgerEntryOfModule(resolveSpecifier(from, '@rf/ui'))).toBe('@/plugins/api/ui')
    // Not a prefix match on the bare name: `@rfx` is somebody's package.
    expect(resolveSpecifier(from, '@rfx/thing')).toBeNull()
  })
})

// ---- the index in the rf-plugin reference --------------------------------------------------------

describe('"What you want to do" in the rf-plugin reference', () => {
  const reference = readFileSync(
    path.join(REPO_ROOT, '.claude/skills/rf-plugin/reference.md'),
    'utf8'
  )
  const section = reference.slice(reference.indexOf('## What you want to do'))
  const rows = section
    .slice(0, section.indexOf('\n## ', 3))
    .split('\n')
    .filter(line => /^\| .* \| `[^`]+` \| `[^`]+` \|$/.test(line))
    .map(line => {
      const codes = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1])
      return { line, use: codes.at(-2) as string, from: codes.at(-1) as string }
    })

  /**
   * An index nobody checks is worse than none: it sends the next reader to a name that is not
   * there. Every `Use` must be a member of its `From` entry in the surface this checkout publishes.
   */
  it('names only members that exist, each under the entry it says', () => {
    const ledger = readLedger(REPO_ROOT) as Ledger
    expect(rows.length).toBeGreaterThan(30)
    const missing = rows.filter(r => !ledger.has(r.from, r.use)).map(r => r.line)
    expect(missing).toEqual([])
  })
})
