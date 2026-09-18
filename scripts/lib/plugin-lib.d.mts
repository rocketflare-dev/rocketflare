/**
 * Hand-written types for `plugin-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/plugin-lib.test.ts` is what typechecks against this.
 */
import type { Ledger, PluginUses } from './surface.d.mts'
import type { Surface } from './upgrade-lib.d.mts'

export const PLUGIN_ID_RE: RegExp
export const RESERVED_PLUGIN_IDS: readonly string[]
export function pluginIdProblem(id: unknown): string | null
export function camelId(id: string): string

export type BarrelKind = 'shared' | 'server' | 'ui' | 'schema' | 'worker' | 'cli'
export interface BarrelDefinition {
  file: string
  /** `null` for the two `export *` barrels (`schema`, `worker`), which declare no tuple. */
  constName: string | null
  suffix: string | null
  /**
   * The "this file is still a module" marker an `export *` barrel falls back to when its last
   * plugin goes. Absent on the four list barrels, which always declare a const.
   */
  empty?: string
  specifier(id: string): string
  /** The file whose presence means the plugin ships this half. */
  half(id: string): string
}
export const BARRELS: Readonly<Record<BarrelKind, BarrelDefinition>>
export const BARREL_KINDS: readonly BarrelKind[]
export function barrelExportName(kind: BarrelKind, id: string): string | null
export function barrelLines(kind: BarrelKind, id: string): string[]
export function hasBarrelLine(text: string, kind: BarrelKind, id: string): boolean
export function tupleEntries(text: string, constName: string): string[]
export function addBarrelLine(text: string, kind: BarrelKind, id: string): string
export function removeBarrelLine(text: string, kind: BarrelKind, id: string): string

/** One line a plugin declares for a core file it may not edit itself (D31). */
export interface CoreEdit {
  /** Repo-relative path of the core file, e.g. `apps/web/vite.config.ts`. */
  file: string
  /** Insert after the first line CONTAINING this text; anchored, never a line number. */
  after: string
  /** The line(s) to insert, at the anchor's indentation. */
  lines: string[]
}
export function applyCoreEdits(text: string, edits: CoreEdit[]): string
export function revertCoreEdits(text: string, edits: CoreEdit[]): string
export function coreEditsByFile(manifest: { coreEdits?: CoreEdit[] }): Map<string, CoreEdit[]>

export type FileRole = 'copy' | 'note' | 'fragment' | 'meta' | 'repo-only' | 'refused'
export const FILE_ROLES: readonly FileRole[]
export function pluginRoots(id: string): string[]
export const PLUGIN_MANIFEST_FILE: string
export interface FileClassification {
  role: FileRole
  reason?: string
  target?: string
  root?: string
}
export function classifyPluginFile(relPath: string, id: string): FileClassification

/**
 * The binding types provisioning can write. Pinned against
 * `apps/web/scripts/provision/plugin-resources.ts`'s `SUPPORTED_PLUGIN_BINDING_TYPES` by
 * `plugin-lib.test.ts` — one is TypeScript, one has to be loadable from a plain `.mjs` script.
 */
export const SUPPORTED_PLUGIN_BINDING_TYPES: readonly [
  'kv',
  'queue',
  'r2',
  'workflow',
  'durable_object',
]
/** The subset an account must CREATE; `wrangler deploy` registers the other two from the toml. */
export const CREATED_PLUGIN_BINDING_TYPES: readonly ['kv', 'queue', 'r2']
/** The types whose block names a class exported from the Worker entry (the sixth barrel). */
export const CLASS_PLUGIN_BINDING_TYPES: readonly ['workflow', 'durable_object']
/** The types carrying an account-scoped resource name, which must differ between environments. */
export const NAMED_PLUGIN_BINDING_TYPES: readonly ['kv', 'queue', 'r2', 'workflow']
export const DO_STORAGE_KINDS: readonly ['sqlite', 'none']
export function pluginPlatformProblems(manifest: PluginManifest): string[]
/** `plugin-<id>-v<n>` — append-only, host-owned, never renumbered. */
export function pluginMigrationTag(pluginId: string, n?: number): string
export function nextPluginMigrationTag(
  existingTags: readonly string[],
  pluginId: string
): string

/** A required peer plugin: an id alone asks for presence, `minVersion` adds a FLOOR. */
export type PluginRequirement = string | { id: string; minVersion?: string | null }
export interface PluginRequires {
  surfaces?: string[]
  plugins?: PluginRequirement[]
}
export interface PluginManifest {
  id: string
  label?: string
  version?: string
  repo?: string
  subdir?: string
  anchor?: string
  /**
   * The oldest kit release this plugin supports — ONE version, no ceiling, and a TOP-LEVEL key.
   *
   * It replaces `requires.kit`, which was a semver range and therefore a prediction about kits
   * that did not exist yet. Which future kit still fits is measured by `uses` against the kit's
   * ledger instead of guessed at here.
   */
  minKit?: string
  /**
   * What this plugin uses of the host surface: `{ [entry]: [symbol names] }`.
   *
   * **Derived, never hand-written** — `pnpm plugin export` writes it from the plugin's own
   * imports. It is one side of the set difference that replaced `requires.pluginApi`.
   */
  uses?: PluginUses
  paths?: string[]
  registries?: string[]
  requires?: PluginRequires
  dependencies?: Record<string, Record<string, string>>
  bindings?: Array<{
    type: string
    binding?: string
    /** The account-scoped half; absent on a `durable_object`, which creates no resource. */
    name?: string
    consumer?: boolean
    /** `workflow` / `durable_object`: the class the sixth barrel re-exports into `worker.ts`. */
    className?: string
    /** `durable_object` only, and required there — it picks new_sqlite_classes vs new_classes. */
    storage?: string
  }>
  crons?: Array<string | { cron: string; task?: string }>
  apiPrefixes?: string[]
  vars?: Array<string | { key?: string; name?: string; example?: string; secret?: boolean }>
  workerExports?: string[]
  schema?: { tables?: string[]; rlsExcluded?: string[] }
  migrations?: string[]
}

/** The installed plugins a move to kit `version` would leave unsupported (vendored ones exempt). */
export function unsupportedForKit(
  plugins: Array<{
    id: string
    source?: { repo?: string; subdir?: string } | null
    minKit?: string | null
  }>,
  at: { kitRepo?: string | null; version?: string | null }
): Array<{ id: string; minKit?: string | null }>

/**
 * A plugin's declared floor. **Top level only** — a fallback to `requires.minKit` would disagree
 * with `.github/workflows/plugin-ci.yml`, which reads the top-level key and nothing else.
 */
export function floorOf(m: { minKit?: string | null } | null | undefined): string | null

export function checkRequirements(input: {
  requires?: PluginRequires
  /** The plugin's floor. Omitted or null, no kit version is checked against it. */
  minKit?: string | null
  /** What the plugin uses of the host surface; with `ledger`, the observed compatibility check. */
  uses?: PluginUses | null
  /** The kit's ledger. Omitted or null, the surface is not checked — the CALLER owns that. */
  ledger?: Ledger | null
  kitVersion: string
  presentSurfaces?: readonly string[]
  installedPlugins?: ReadonlyArray<{ id: string; version?: string | null }>
  vendored?: boolean
}): string[]
export function parsePluginRequirement(entry: PluginRequirement): {
  id: string
  minVersion: string | null
}
/**
 * Re-exported from `upgrade-lib.mjs`, which owns the one implementation (two that disagreed about
 * a normalised URL is exactly the bug this removed).
 */
export { isVendored } from './upgrade-lib.d.mts'

export function buildPluginSurface(
  manifest: PluginManifest,
  source: { repo: string; subdir?: string; commit?: string | null; at: string }
): Surface
export function surfaceDirectories(surface: Surface): string[]
export function archiveSql(id: string, tables: readonly string[]): string

export interface AddPlan {
  manifest: PluginManifest
  source: { repo: string; subdir?: string; ref?: string | null; commit?: string | null }
  host: { label: string; kitVersion: string; recordsIn: string; translated: boolean }
  vendored: boolean
  problems: string[]
  files: Array<{ path: string } & FileClassification>
  byRoot: Record<string, number>
  barrels: BarrelKind[]
  /** Dependencies the host, or a peer plugin, already pins at another range. */
  clashes?: readonly DependencyClash[]
  verify?: string | null
}
export function renderAddPlan(plan: AddPlan): string[]

/**
 * What a step costs somebody (D31). `declarative` never appears in a plan — the tooling does it —
 * so the only two a reader ever sees are `agent` (an instruction PLUS a check) and `human` (a
 * decision the tooling stops for).
 */
export type StepKind = 'declarative' | 'agent' | 'human'
export const STEP_KINDS: readonly StepKind[]
export interface PlanStep {
  kind: StepKind
  /** Stable across runs, so a caller can key on it (`secret-value:APPROVALS_TOKEN`). */
  id: string
  title: string
  /** The exact command, or the exact edit, with nothing left to infer. */
  command: string
  /** What is observably true afterwards. */
  expect: string
  /** What proves it — a command for an `agent` step, a judgement for a `human` one. */
  assert: string
}
export function planSteps(
  manifest: PluginManifest,
  options?: { fragments?: readonly string[]; clashes?: readonly DependencyClash[] }
): PlanStep[]
export function removeSteps(
  manifest: PluginManifest,
  options?: { archive?: boolean; migrationTag?: string | null }
): PlanStep[]
export function renderSteps(steps: readonly PlanStep[], heading?: string): string[]
export function addPlanJson(plan: AddPlan): Record<string, unknown>
export function renderList(
  surfaces: readonly Surface[],
  options?: { sidecarIds?: readonly string[] }
): string[]

// ---------------------------------------------------------------- the audit

/** One finding, in the shape an agent can act on: file, where in it, what, and the exact edit. */
export interface Diagnostic {
  file: string
  /** 1-based, and present only when the complaint is AT a place in that file. */
  line?: number | null
  problem: string
  fix: string
}
export function renderDiagnostic(d: Diagnostic): string
export function jsonKeyLine(source: string, keyPath: string): number | null

/** Everything wrong with a manifest, each naming the FIELD and its legal values. */
export function pluginManifestProblems(
  manifest: unknown
): Array<{ field: string; problem: string; fix: string }>

/**
 * The value names a `worker-exports.ts` exports. `opaque` when it carries an `export *`, whose
 * names cannot be known without resolving the module — both directions are skipped for one.
 */
export function workerExportNames(source: string): { names: string[]; opaque: boolean }

/** Structural evidence that a test file proves cross-tenant isolation. */
export interface IsolationEvidence {
  /** `describe('… isolation …')` or the equivalent. */
  named: boolean
  /** Names a SECOND organisation (`otherTenant`, `tenantB`…). */
  secondTenant: boolean
  /** How many tenants the file creates. */
  tenantsCreated: number
  ok: boolean
}
export function isolationEvidence(source: string): IsolationEvidence

/**
 * Where an install's `subdir` comes from, in precedence order.
 *
 * `||` and not `??`: a manifest shipping `"subdir": ""` is nullish-coalescing's blind spot, and it
 * beat an explicit `--subdir` — recording the surface as root-relative and breaking the next
 * `plugin upgrade`, which diffs against that path.
 */
/**
 * Whether a source DECLARES `name` as a property or method rather than mentioning it. Comments are
 * stripped first — a doc comment saying a hook is absent otherwise satisfies a substring search.
 */
export function declaresProperty(source: string, name: string): boolean

export function resolveSubdir(input: {
  flag?: string | null
  manifest?: string | null
  source?: string | null
}): string

/** A workspace `package.json` as read off disk — only the two sections a range can live in. */
export interface HostPackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** A declared dependency the host package does not have, or has at another range. */
export interface DependencyIssue {
  pkg: string
  name: string
  /** What the plugin declares. */
  range: string
  /** What the host has — `null` when the package is absent altogether. */
  have: string | null
}
export function missingDependencies(
  manifest: PluginManifest,
  packageJsons?: Record<string, HostPackageJson | null>
): DependencyIssue[]

/** A dependency two things want at different ranges. */
export interface DependencyClash {
  pkg: string
  name: string
  /** What the plugin being installed wants. */
  range: string
  /** Who already holds a different one — a `package.json` path, or a peer plugin. */
  holder: string
  theirs: string
}
export function dependencyClashes(
  manifest: PluginManifest,
  context?: {
    packageJsons?: Record<string, HostPackageJson | null>
    installed?: ReadonlyArray<{ id: string; dependencies?: Record<string, Record<string, string>> }>
  }
): DependencyClash[]
export function describeClash(clash: DependencyClash): string

/** A table two installed plugins both declare, reported once per plugin involved. */
export interface TableClash {
  table: string
  /** The plugin this entry is filed against. */
  id: string
  /** The other plugins declaring the same name, sorted. */
  others: string[]
}
export function tableClashes(
  manifests?: ReadonlyArray<PluginManifest | null | undefined>
): TableClash[]
