/**
 * Hand-written types for the exports of `kit-check.mjs` (the workspace has no `allowJs`). Keep in
 * step with the script; `apps/web/tests/config/kit-check.test.ts` is what typechecks against this.
 */

export type CommandTarget = { kind: 'file'; file: string } | { kind: 'script'; script: string }
export function commandTarget(command: string): CommandTarget | null

export interface ScopedName {
  where: string
  name: unknown
  worker?: boolean
}
export function scopedNames(toml: Record<string, unknown>): ScopedName[]

export interface TomlRuleOptions {
  slug: string
  env: 'production' | 'staging'
  stagingSuffix: string
  provisioned?: boolean
  label: string
}
export function tomlProblems(toml: Record<string, unknown>, options: TomlRuleOptions): string[]
export function tomlShape(
  toml: Record<string, unknown>,
  options: Omit<TomlRuleOptions, 'label' | 'provisioned'>
): Record<string, unknown>
export function diffPaths(a: unknown, b: unknown, at?: string, out?: string[]): string[]

export function ciProblems(
  workflow: unknown,
  text: string,
  ci: { requiredCheck: string; verifiedVariable?: string }
): string[]
export function releaseProblems(
  workflow: unknown,
  release: { file: string; environmentInput: string }
): string[]

export interface KitCheck {
  id: 'manifest' | 'files' | 'ci' | 'release' | 'tomls' | 'gate-list'
  ok: boolean
  problems: string[]
}
export interface KitCheckReport {
  ok: boolean
  kit: { id: string; slug: string; isCopy: boolean } | null
  checks: KitCheck[]
  warnings: string[]
}
export function checkKit(
  dir: string,
  options?: { provisioned?: boolean; exec?: boolean }
): KitCheckReport
