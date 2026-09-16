/**
 * `packages/shared` may import only zod, its own siblings, type-only `@casl/ability` and
 * `@ag-ui/core`. The reason is that this package bundles into the browser AND loads in the CLI, so
 * anything with a platform API in it — a driver, a server framework, a React runtime — breaks one
 * of the two consumers. It was documentation-only; this is the check.
 *
 * `@ag-ui/core` is on the list because it satisfies the reason (zod schemas, one dependency, no
 * platform APIs) and because AG-UI is a wire format: the server and the UI must validate against
 * the SAME runtime schema, which a loose mirror cannot give. A fifth dependency needs the same
 * written justification, in `packages/shared/CLAUDE.md` and the root `CLAUDE.md`.
 *
 * The second half of this file is a different rule with the same shape: **`src/plugins/**` may not
 * import one of the five composers AT RUNTIME** (D31). Those five read the plugin barrel to open
 * their closed sets, so a plugin module importing one back closes a cycle through
 * `plugins/index.ts` — and two zod modules in a cycle do not fail to compile, they crash at module
 * evaluation with one side holding `undefined`. Nothing but a source scan can see it, because with
 * no plugins installed the cycle does not exist yet: the file that would close it has not been
 * written.
 *
 * A whole-declaration `import type { X } from '../features'` is erased before anything evaluates,
 * so it cannot close that cycle and is allowed — it is how `SharedPlugin.features` is typed against
 * the one `FeatureDefinition` instead of a restatement that drifts. `import { type X } from` is
 * NOT: eliding every specifier leaves an empty import clause, and whether that is dropped or kept
 * as a bare side-effect import is the toolchain's decision, not ours. (`tsconfig.base.json` sets
 * `isolatedModules: true` and does NOT set `verbatimModuleSyntax`, under which `tsc` drops it —
 * but esbuild, which is what actually bundles the Worker and the UI, decides separately, and the
 * rule should not rest on that.)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SHARED_ROOT = path.resolve(__dirname, '../../../../packages/shared')

/** Bare specifiers `packages/shared/src/**` may name, and the file each is confined to. */
const ALLOWED: Record<string, { files?: string[]; typeOnly?: true }> = {
  zod: {},
  '@casl/ability': { typeOnly: true },
  '@ag-ui/core': { files: ['src/ai/agui.ts'] },
}

/**
 * The modules that read the plugin barrel. Each one owns a set a plugin extends — agent keys, job
 * variants, CASL subjects, feature keys, the `access.changed` query-key roots — so each one is
 * already downstream of `plugins/index.ts`.
 */
const COMPOSERS = ['ai/agents.ts', 'jobs.ts', 'permissions.ts', 'features.ts', 'realtime.ts']

function sharedSources(): string[] {
  // `--others --exclude-standard` too, so a file is scanned the moment it is written rather
  // than only once it is staged.
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'],
    { cwd: SHARED_ROOT, encoding: 'utf8' }
  )
  return out
    .split('\n')
    .filter(f => f.endsWith('.ts'))
    .sort()
}

interface Specifier {
  file: string
  /** The package root — `@casl/ability/extra` counts as `@casl/ability`; the allow-list is per package. */
  module: string
  typeOnly: boolean
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string)
}

/** Every bare (non-relative) module specifier in the package, with whether the import is type-only. */
function specifiers(): Specifier[] {
  const found: Specifier[] = []
  for (const file of sharedSources()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(SHARED_ROOT, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const module = node.moduleSpecifier.text
        if (!module.startsWith('.')) {
          const typeOnly = ts.isImportDeclaration(node)
            ? Boolean(node.importClause?.isTypeOnly)
            : node.isTypeOnly
          found.push({ file, module: packageOf(module), typeOnly })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    found.push(
      ...[...source.text.matchAll(/\bimport\(\s*['"]([^'".][^'"]*)['"]\s*\)/g)].map(m => ({
        file,
        module: packageOf(m[1] as string),
        typeOnly: false,
      }))
    )
  }
  return found
}

describe('packages/shared imports', () => {
  it('names only allow-listed packages', () => {
    const offenders = specifiers()
      .filter(s => !(s.module in ALLOWED))
      .map(s => `${s.file} imports ${s.module}`)
    expect(offenders).toEqual([])
  })

  it('keeps each restricted dependency in the file that justifies it', () => {
    const offenders = specifiers()
      .filter(s => ALLOWED[s.module]?.files && !ALLOWED[s.module]?.files?.includes(s.file))
      .map(s => `${s.file} imports ${s.module}`)
    expect(offenders).toEqual([])
  })

  it('keeps `@casl/ability` type-only', () => {
    const offenders = specifiers()
      .filter(s => ALLOWED[s.module]?.typeOnly && !s.typeOnly)
      .map(s => `${s.file} imports ${s.module} at runtime`)
    expect(offenders).toEqual([])
  })

  it('finds the imports it is scanning for', () => {
    // A regression in the scanner would make every assertion above pass vacuously.
    const modules = new Set(specifiers().map(s => s.module))
    expect(modules).toContain('zod')
    expect(modules).toContain('@ag-ui/core')
  })
})

// ---- the plugin runtime-import rule (D31) -------------------------------------------------------

interface RelativeImport {
  /** Resolved against the importing file, so `./types` from `src/plugins/` is `src/plugins/types`. */
  target: string
  /**
   * The WHOLE declaration is type-only (`import type { X } from`), which is the only spelling that
   * is unconditionally erased. An inline `import { type X } from` is deliberately NOT type-only
   * here: its import clause can survive empty as a side-effect import, which is a runtime edge.
   */
  typeOnly: boolean
}

/** Every relative import in one source text, resolved to a path relative to `packages/shared`. */
function relativeImports(file: string, text: string): RelativeImport[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const found: RelativeImport[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.startsWith('.')
    ) {
      found.push({
        target: path.posix.normalize(
          path.posix.join(path.posix.dirname(file), node.moduleSpecifier.text)
        ),
        typeOnly: ts.isImportDeclaration(node)
          ? Boolean(node.importClause?.isTypeOnly)
          : node.isTypeOnly,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** The composer a resolved relative import names, or null. `./x` and `./x.ts` are the same file. */
function composerOf(target: string): string | null {
  return (
    COMPOSERS.find(c => target === `src/${c}` || target === `src/${c.replace(/\.ts$/, '')}`) ?? null
  )
}

/** `<file> imports <composer> at runtime` for every RUNTIME composer import in one source text. */
function composerOffenders(file: string, text: string): string[] {
  return relativeImports(file, text)
    .filter(i => !i.typeOnly)
    .map(i => composerOf(i.target))
    .filter((c): c is string => c !== null)
    .map(c => `${file} imports ${c} at runtime`)
}

const FIXTURE = 'src/plugins/orders/index.ts'

describe('packages/shared/src/plugins never imports a composer at runtime', () => {
  const pluginFiles = () => sharedSources().filter(f => f.startsWith('src/plugins/'))

  it('recognises a composer however it is spelled, and nothing else', () => {
    expect(composerOf('src/features')).toBe('features.ts')
    expect(composerOf('src/ai/agents')).toBe('ai/agents.ts')
    expect(composerOf('src/ai/agents.ts')).toBe('ai/agents.ts')
    expect(composerOf('src/ai/prompts')).toBeNull()
    expect(composerOf('src/plugins/types')).toBeNull()
  })

  it('names five composers that all exist', () => {
    const files = new Set(sharedSources())
    for (const composer of COMPOSERS) expect(files.has(`src/${composer}`), composer).toBe(true)
  })

  it('allows a whole-declaration type-only import — that is how a plugin is typed', () => {
    expect(
      composerOffenders(FIXTURE, "import type { FeatureDefinition } from '../../features'")
    ).toEqual([])
    expect(composerOffenders(FIXTURE, "export type { JobInput } from '../../jobs'")).toEqual([])
  })

  it('refuses the inline `type` spelling, whose import clause can survive empty', () => {
    expect(
      composerOffenders(FIXTURE, "import { type FeatureDefinition } from '../../features'")
    ).toHaveLength(1)
  })

  it('refuses a value import outright, and leaves a non-composer sibling alone', () => {
    expect(composerOffenders(FIXTURE, "import { FEATURE_FLAGS } from '../../features'")).toEqual([
      'src/plugins/orders/index.ts imports features.ts at runtime',
    ])
    expect(
      composerOffenders(FIXTURE, "import { promptKeySchema } from '../../ai/prompts'")
    ).toEqual([])
  })

  it('holds for every plugin file that exists', () => {
    const offenders = pluginFiles().flatMap(file =>
      composerOffenders(file, readFileSync(path.join(SHARED_ROOT, file), 'utf8'))
    )
    expect(
      offenders,
      'A plugin module that imports a composer AT RUNTIME closes a cycle through ' +
        'plugins/index.ts, and one side of it reads `undefined` at module evaluation. If you only ' +
        'need the type, use a whole-declaration `import type { X } from` — never ' +
        '`import { type X } from`, whose empty import clause may survive as a side-effect import.'
    ).toEqual([])
  })

  it('finds the files it is scanning for', () => {
    // Vacuous the day `plugins/` moves or the glob stops matching.
    expect(pluginFiles()).toContain('src/plugins/types.ts')
    expect(pluginFiles()).toContain('src/plugins/index.ts')
    // ...and the scanner really reads the files' own relative specifiers.
    const text = readFileSync(path.join(SHARED_ROOT, 'src/plugins/index.ts'), 'utf8')
    expect(relativeImports('src/plugins/index.ts', text).map(i => i.target)).toContain(
      'src/plugins/types'
    )
  })
})
