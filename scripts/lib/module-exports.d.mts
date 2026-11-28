/**
 * Hand-written types for `module-exports.mjs` (no `allowJs`). Keep in step with its exports.
 */

/** One exported name, resolved to its declaration. */
export interface ModuleExport {
  name: string
  /** `interface` · `type` · `class` · `function` · `enum` · `const` · `value` · `external`. */
  kind: string
  /** Repo path of the declaring file, or the package specifier for `external`. */
  file: string
  /** An interface's own member names, in declaration order (`()` for a call or index signature). */
  members: string[]
}

export interface ExportReader {
  /** Every name `file` exports, sorted by name. Throws naming the file on a parse error. */
  exportsOf(file: string): ModuleExport[]
  /** `name` as `file` exports it, or null. */
  resolveExport(file: string, name: string): Omit<ModuleExport, 'name'> | null
}

export function createExportReader(options: {
  repoRoot: string
  /** A specifier to a repo path (extension optional), or null for a package outside the repo. */
  resolve: (importer: string, specifier: string) => string | null
}): ExportReader
