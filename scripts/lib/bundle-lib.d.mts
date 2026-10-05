/**
 * Hand-written types for `bundle-lib.mjs` (the workspace has no `allowJs`). Keep in step with the
 * exports there; `apps/web/tests/config/bundle-lib.test.ts` typechecks against this.
 */
export const BUNDLE_PROTOCOL: number

export type Entries = Record<string, Buffer>

export interface BundleManifest {
  protocol: number
  tag: string
  version: string
  commit: string
  treeSha: string
  main: string
  compatibility_date: string | null
  compatibility_flags: string[]
  wranglerVersion: string | null
  files: Record<string, string>
  bundleSha256: string
}

export interface Bundle {
  manifest: BundleManifest
  entries: Entries
}

export interface ReleaseAsset {
  id: number
  name: string
  size?: number
}

export interface Release {
  id: number
  tag_name: string
  draft: boolean
  prerelease?: boolean
  created_at?: string
  upload_url?: string
  assets?: ReleaseAsset[]
}

export function assetName(tag: string): string
export function isWorkerModule(rel: string): boolean
export function sha256(bytes: Buffer | string): string
export function bundleDigest(files: Record<string, string>): string
export function readTomlBasics(text: string): {
  main: string | undefined
  compatibility_date: string | undefined
  compatibility_flags: string[]
}
export function entryModule(main: string): string
export function safePath(p: string): boolean
export function collectEntries(input: { worker: Entries; ui?: Entries }): Entries
export function makeManifest(input: {
  tag: string
  version: string
  commit: string
  treeSha: string
  toml: string
  wranglerVersion?: string | null
  entries: Entries
}): BundleManifest
export function tar(entries: Entries): Buffer
export function untar(buf: Buffer): Entries
export function packBundle(bundle: { manifest: BundleManifest; entries: Entries }): Buffer
export function unpackBundle(tgz: Buffer): Bundle
export function verifyBundle(
  bundle: { manifest: BundleManifest | null; entries: Entries },
  expect: { tag?: string; commit?: string; treeSha?: string; toml?: string }
): string[]
export function splitEntries(entries: Entries): { worker: Entries; ui: Entries }

export type ProductionSource =
  | { source: 'build'; reason: string }
  | { source: 'bundle'; reason: string; asset: ReleaseAsset }
export function productionSource(input: {
  deployer: boolean
  tag: string
  release: Release | null
}): ProductionSource

export type AttachPlan =
  | { action: 'create-draft'; release?: undefined }
  | { action: 'upload'; release: Release }
  | { action: 'replace'; release: Release; asset: ReleaseAsset }
  | { action: 'keep'; release: Release; asset: ReleaseAsset }
export function attachPlan(releases: Release[], tag: string): AttachPlan
