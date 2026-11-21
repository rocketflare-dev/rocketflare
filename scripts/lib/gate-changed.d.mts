/**
 * Hand-written types for `gate-changed.mjs` (the workspace has no `allowJs`). Keep in step with
 * the exports there; `apps/web/tests/kit-only/gate-changed.test.ts` typechecks against this.
 */

export interface WorkspacePackage {
  dir: string
  name: string
  deps: string[]
  scripts: string[]
}

export interface TestFile {
  file: string
  project: string
}

export const FULL_GATE_TRIGGERS: readonly string[]
export function globToRegExp(glob: string): RegExp
export function matchesAny(file: string, globs: readonly string[]): boolean
export function affectedPackages(
  files: string[],
  packages: Omit<WorkspacePackage, 'scripts'>[]
): string[]

export type ChangedPlan =
  | { full: string }
  | {
      lint: string[]
      typecheck: string[]
      test: { web: boolean; packages: string[] }
      build: string[]
    }

export function planChanged(input: {
  changed: string[]
  existing: string[]
  packages: WorkspacePackage[]
}): ChangedPlan

export function readsFiles(source: string, fsHelpers?: string[]): boolean
export function selectTests(input: {
  all: TestFile[]
  related: TestFile[]
  sources: Record<string, string>
  changed: string[]
  fsHelpers?: string[]
}): Record<string, string[]>
