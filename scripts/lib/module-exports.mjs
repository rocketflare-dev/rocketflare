/**
 * What a TypeScript module EXPORTS, by name and kind, read with a parser and no type checker.
 *
 * The declared plugin entries are barrels: most of what they export is a re-export, often two or
 * three hops from the declaration (`export { x } from './a'`, `import { y } from './b'; export { y }`,
 * `export * from './c'`, `export { default as Z } from './d'`). The question this answers — "which
 * names does this module provide, and is each a function, an interface, a const…" — needs only
 * those hops followed to the declaration's SYNTAX, which a parser has. The type checker the first
 * version used (`typescript6`) was there for signatures, and the surface no longer records any
 * (#182): a moved-symbol suggestion needs a name, not a type.
 *
 * Generic on purpose. `scripts/plugin-api-doc.mjs` drives it over the declared plugin entries, and
 * a boundary check over any other published entry (an app's own domains, say) can drive it over
 * theirs with nothing here changing: the caller supplies the files and the specifier resolver.
 *
 * Kinds are the ones the ledger has always used — `interface`, `type`, `class`, `function`, `enum`,
 * `const`, and `value` for anything else (a namespace, `export default <expression>`, `export * as`).
 * A name that resolves to a package outside the repository is `external`: a barrel re-exporting a
 * third-party symbol is still providing it, but its declaration is not this repository's to read.
 *
 * Deterministic and pure apart from reading files; a parse error is a throw naming the file, never
 * a silently shorter surface.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseSync } from 'oxc-parser'

/** The extensions a specifier without one is probed with, in the order TypeScript tries them. */
const PROBES = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.mts',
  '.js',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.d.ts',
]

/**
 * A reader over one repository. `resolve(importerRepoPath, specifier)` maps a specifier to a
 * repo-relative module path WITHOUT an extension (or with one), or null for a package outside the
 * repository; the reader probes the extensions itself.
 */
export function createExportReader({ repoRoot, resolve }) {
  const parsed = new Map()
  const exportsCache = new Map()

  /** A repo path (with or without an extension) to the file that exists, or null. */
  function fileFor(modulePath) {
    const candidates = [modulePath, ...PROBES.map(p => `${modulePath}${p}`)]
    if (/\.js$/.test(modulePath)) candidates.unshift(modulePath.replace(/\.js$/, '.ts'))
    for (const candidate of candidates) {
      const abs = path.join(repoRoot, candidate)
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate
    }
    return null
  }

  /** The target file of `specifier` imported from `importer`, `{ external }` for a package. */
  function target(importer, specifier) {
    const modulePath = resolve(importer, specifier)
    if (!modulePath) return { external: specifier }
    const file = fileFor(modulePath)
    if (!file) throw new Error(`${importer}: cannot resolve '${specifier}' (${modulePath})`)
    return { file }
  }

  function parse(file) {
    const cached = parsed.get(file)
    if (cached) return cached
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    const result = parseSync(file, source, { sourceType: 'module' })
    if (result.errors.length > 0) {
      throw new Error(`${file}: ${result.errors.map(e => e.message).join('; ')}`)
    }
    const module = summariseModule(result.program, source)
    parsed.set(file, module)
    return module
  }

  /** `{ kind, file, members }` for `name` as `file` exports it, or null when it does not. */
  function resolveExport(file, name, seen = new Set()) {
    const key = `${file}#${name}`
    if (seen.has(key)) return null
    seen.add(key)
    const module = parse(file)
    const own = module.exports.get(name)
    if (own) return resolveBinding(file, own, seen)
    if (name === 'default') return null
    for (const specifier of module.stars) {
      const t = target(file, specifier)
      if (t.external) continue
      const found = resolveExport(t.file, name, seen)
      if (found) return found
    }
    return null
  }

  /** Follow one binding — a local declaration, an import, or a re-export — to its declaration. */
  function resolveBinding(file, binding, seen) {
    if (binding.declaration) return { ...binding.declaration, file }
    if (binding.local !== undefined) {
      const module = parse(file)
      const declaration = module.locals.get(binding.local)
      if (declaration) return { ...declaration, file }
      const imported = module.imports.get(binding.local)
      if (imported) return resolveBinding(file, imported, seen)
      throw new Error(`${file}: exports '${binding.local}', which it neither declares nor imports`)
    }
    const t = target(file, binding.from)
    if (t.external) return { kind: 'external', file: binding.from, members: [] }
    if (binding.imported === '*') return { kind: 'value', file: t.file, members: [] }
    const found = resolveExport(t.file, binding.imported, seen)
    if (!found) throw new Error(`${file}: '${binding.imported}' is not exported by ${t.file}`)
    return found
  }

  /**
   * Every name `file` exports, `[{ name, kind, file, members }]` sorted by name: `file` is where
   * the declaration lives, `members` an interface's own member names (empty for anything else).
   *
   * `export *` contributes every name of its target except `default` and any name the module
   * exports itself, as ECMAScript says; two stars providing one name is ambiguous and dropped.
   */
  function exportsOf(file) {
    const cached = exportsCache.get(file)
    if (cached) return cached
    const module = parse(file)
    const names = new Set(module.exports.keys())
    const fromStars = new Map()
    for (const specifier of module.stars) {
      const t = target(file, specifier)
      if (t.external) {
        throw new Error(
          `${file}: \`export * from '${specifier}'\` — a package's names cannot be listed`
        )
      }
      for (const inner of exportsOf(t.file)) {
        if (inner.name === 'default' || names.has(inner.name)) continue
        fromStars.set(inner.name, fromStars.has(inner.name) ? null : t.file)
      }
    }
    const out = []
    for (const name of names) out.push({ name, ...resolveExport(file, name) })
    for (const [name, from] of fromStars) {
      if (from !== null) out.push({ name, ...resolveExport(from, name) })
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'en'))
    exportsCache.set(file, out)
    return out
  }

  return { exportsOf, resolveExport }
}

// ---------------------------------------------------------------- one module's syntax

/**
 * One module's top level, reduced to what export resolution needs:
 *
 * - `locals`  — name → the FIRST declaration of it (declaration merging keeps source order, which
 *   is the declaration a type checker reports first too);
 * - `imports` — local name → `{ from, imported }` (`imported` is `default`, `*` or the name);
 * - `exports` — exported name → `{ declaration }`, `{ local }` or `{ from, imported }`;
 * - `stars`   — the specifiers of every `export * from`.
 */
function summariseModule(program, source) {
  const locals = new Map()
  const imports = new Map()
  const exports = new Map()
  const stars = []
  const declare = (name, declaration) => {
    if (name && !locals.has(name)) locals.set(name, declaration)
  }

  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      for (const s of node.specifiers ?? []) {
        const imported =
          s.type === 'ImportDefaultSpecifier'
            ? 'default'
            : s.type === 'ImportNamespaceSpecifier'
              ? '*'
              : nameOf(s.imported)
        imports.set(s.local.name, { from: node.source.value, imported })
      }
      continue
    }
    if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        exports.set(nameOf(node.exported), { from: node.source.value, imported: '*' })
      } else stars.push(node.source.value)
      continue
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration) {
        for (const [name, declaration] of declarationsIn(node.declaration, source)) {
          declare(name, declaration)
          exports.set(name, { local: name })
        }
      }
      for (const s of node.specifiers ?? []) {
        const exported = nameOf(s.exported)
        const local = nameOf(s.local)
        exports.set(
          exported,
          node.source ? { from: node.source.value, imported: local } : { local }
        )
      }
      continue
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const d = node.declaration
      if (d.type === 'Identifier') exports.set('default', { local: d.name })
      else {
        const [first] = declarationsIn(d, source)
        // An anonymous `export default class {}` / `function () {}` is still its kind; a bare
        // expression has none.
        const declaration = first?.[1] ?? anonymous(d) ?? { kind: 'value', members: [] }
        if (first?.[0]) declare(first[0], declaration)
        exports.set('default', { declaration })
      }
      continue
    }
    if (node.type === 'TSExportAssignment') {
      exports.set('default', { declaration: { kind: 'value', members: [] } })
      continue
    }
    for (const [name, declaration] of declarationsIn(node, source)) declare(name, declaration)
  }
  return { locals, imports, exports, stars }
}

/** `[[name, { kind, members }]]` for every binding one declaration introduces. */
function declarationsIn(node, source) {
  switch (node.type) {
    case 'TSInterfaceDeclaration':
      return [[node.id.name, { kind: 'interface', members: interfaceMembers(node, source) }]]
    case 'TSTypeAliasDeclaration':
      return [[node.id.name, { kind: 'type', members: [] }]]
    case 'ClassDeclaration':
      return node.id ? [[node.id.name, { kind: 'class', members: [] }]] : []
    case 'FunctionDeclaration':
    case 'TSDeclareFunction':
      return node.id ? [[node.id.name, { kind: 'function', members: [] }]] : []
    case 'TSEnumDeclaration':
      return [[node.id.name, { kind: 'enum', members: [] }]]
    case 'TSModuleDeclaration':
      return node.id?.type === 'Identifier' ? [[node.id.name, { kind: 'value', members: [] }]] : []
    case 'VariableDeclaration':
      return node.declarations.flatMap(d =>
        bindingNames(d.id).map(n => [n, { kind: 'const', members: [] }])
      )
    default:
      return []
  }
}

function anonymous(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'TSDeclareFunction') {
    return { kind: 'function', members: [] }
  }
  return null
}

/** Every identifier a binding pattern introduces (`const { a, b: [c] } = …` is `a` and `c`). */
function bindingNames(pattern) {
  if (!pattern) return []
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name]
    case 'ObjectPattern':
      return pattern.properties.flatMap(p =>
        bindingNames(p.type === 'RestElement' ? p.argument : p.value)
      )
    case 'ArrayPattern':
      return pattern.elements.flatMap(e => bindingNames(e))
    case 'RestElement':
      return bindingNames(pattern.argument)
    case 'AssignmentPattern':
      return bindingNames(pattern.left)
    default:
      return []
  }
}

/**
 * An interface's OWN members, in declaration order, deduplicated (an overloaded method is one
 * name). A call or index signature has no name and is `()`; a construct signature is not a member
 * a plugin can reach and is skipped. Inherited members are the parent's, not this interface's.
 */
function interfaceMembers(node, source) {
  const out = []
  for (const m of node.body.body) {
    let name = null
    if (m.type === 'TSCallSignatureDeclaration' || m.type === 'TSIndexSignature') name = '()'
    else if (m.key) {
      const text = source.slice(m.key.start, m.key.end)
      name = m.computed ? `[${text}]` : m.key.type === 'Identifier' ? m.key.name : text
    }
    if (name !== null && !out.includes(name)) out.push(name)
  }
  return out
}

/** An `Identifier` or a string `Literal` (`export { x as "y" }`) to its name. */
function nameOf(node) {
  return node.type === 'Identifier' ? node.name : String(node.value)
}
