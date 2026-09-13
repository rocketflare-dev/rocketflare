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
