/**
 * Hand-written types for `manifest.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/manifest-lib.test.ts` is what typechecks against this.
 */
import type { Manifest, Surface } from './upgrade-lib.d.mts'

export const MANIFEST_FILE: string
export const SIDECAR_FILE: string
export const REPO_ROOT: string

/** The git-ignored local record: plugin surfaces installed into this checkout only. */
export interface Sidecar {
  surfaces?: Surface[]
}

export function mergeSidecar(manifest: Manifest | null, sidecar: Sidecar | null): Manifest | null
export function pluginSurfaces(manifest: Manifest | null): Surface[]

export interface ManifestRead {
  /** The manifest with the sidecar's surfaces folded in; null when there is no manifest file. */
  manifest: Manifest | null
  /** `app === null` in the COMMITTED manifest — the one kit-vs-app predicate. */
  isKit: boolean
  /** The raw sidecar, or null when the file does not exist. */
  sidecar: Sidecar | null
  manifestPath: string
  sidecarPath: string
}
export function readManifest(rootDir?: string): ManifestRead

/**
 * The kit version a plugin's `minKit` is checked against: the root `package.json` version in the
 * kit itself, `.rocketflare.json` `kit.version` in a copy (whose root version is the app's own).
 * Throws when the source it needs is missing.
 */
export function hostKitVersion(
  read: Pick<ManifestRead, 'manifest' | 'isKit'>,
  packageJsonVersion: string | null | undefined
): string
