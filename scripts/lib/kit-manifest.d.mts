/**
 * Hand-written types for `kit-manifest.mjs` (no `allowJs`). The manifest itself is typed loosely:
 * its authoritative shape is Launch's zod schema (`@launch/shared/kit-manifest`), which this
 * plain-JS validator mirrors; `apps/web/tests/config/launch-kit-manifest.test.ts` typechecks
 * against this.
 */
export const KIT_MANIFEST_PATH: string
export const KIT_MANIFEST_SCHEMA_VERSION: number
export const PROVISIONABLE_BINDING_KINDS: readonly string[]

// biome-ignore lint/suspicious/noExplicitAny: a JSON document whose shape Launch's zod schema owns
export type KitManifest = Record<string, any>
export function validateManifest(input: unknown): {
  manifest: KitManifest | null
  problems: string[]
}
export function fillTemplate(template: string, values: Record<string, string>): string
