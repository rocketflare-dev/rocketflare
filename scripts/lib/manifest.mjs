/**
 * Reading `.rocketflare.json` — the ONE place the kit-vs-app question is answered (D31).
 *
 * Every tool that touches the manifest has so far re-read and re-interpreted it: `upgrade.mjs`,
 * `release.mjs`, `release-check.mjs`, `changelog-nudge.mjs` and two test files each `JSON.parse` it
 * and each decide for themselves what "this is the kit" means. Plugins make that unaffordable,
 * because a plugin is recorded as a SURFACE and there are now two files it can be recorded in:
 *
 *   - in an app, `.rocketflare.json` itself, committed, so the whole team and CI see it;
 *   - in the KIT (`app === null`), or with `--local` anywhere, the git-ignored
 *     `.rocketflare.local.json` sidecar — because a plugin installed into a kit checkout is an
 *     authoring convenience, not part of what the kit ships, and committing it would push a
 *     plugin's wiring into every copy made from that commit.
 *
 * So `readManifest()` returns the MERGED view plus the two facts a caller needs to write back
 * correctly: whether this is the kit, and whether a sidecar exists. Writers use `isKit` (or an
 * explicit `--local`) to choose the file; readers should not care which one a surface came from.
 *
 * Pure except for `readManifest` itself, which reads the two files.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KIT } from './rename-lib.mjs'
import { isKitManifest } from './upgrade-lib.mjs'

/**
 * Both names are BUILT from `KIT.slug` rather than written as literals, and that is not style.
 * `scripts/rename.mjs` rewrites the kit's name in every file it is not told to skip, and the
 * provenance file is deliberately NOT renamed with the app — so a literal here becomes
 * `.<slug>.json` in a renamed copy and every plugin command then fails to find a file that is
 * sitting right there. `rename-lib.mjs` is on the rename's own exclusion list (the tool has to keep
 * working after it has run), so `KIT.slug` is `rocketflare` for ever, in the kit and in every copy.
 */
export const MANIFEST_FILE = `.${KIT.slug}.json`
export const SIDECAR_FILE = `.${KIT.slug}.local.json`

/** The repository root, from this file's location — the same anchor every other script uses. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Fold the sidecar into the manifest. Only `surfaces` merges: everything else in the manifest
 * (kit provenance, the app's names, the never-port / manual / core lists) describes the checkout
 * and is not something a local install may restate.
 *
 * A sidecar surface with an id the manifest already has REPLACES it, because the local file is the
 * more specific statement — that is what lets an author point a vendored plugin at a working copy
 * without editing the committed manifest.
 */
export function mergeSidecar(manifest, sidecar) {
  const extra = sidecar?.surfaces ?? []
  if (!manifest || extra.length === 0) return manifest
  const overridden = new Set(extra.map(s => s.id))
  return {
    ...manifest,
    surfaces: [...manifest.surfaces.filter(s => !overridden.has(s.id)), ...extra],
  }
}

/** Every surface of `kind: 'plugin'`, in merge order. */
export function pluginSurfaces(manifest) {
  return (manifest?.surfaces ?? []).filter(s => s.kind === 'plugin')
}

function readJson(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`)
  }
}

/**
 * `{ manifest, isKit, sidecar }` for a checkout.
 *
 * `manifest` is null when there is no `.rocketflare.json` at all (somebody deleted it, or this is
 * not a copy of the kit); `isKit` is then false, because an unknown state is not a licence to
 * behave like the kit. `sidecar` is the raw sidecar object or null — a caller that is about to
 * WRITE needs to know whether the file exists, which the merged manifest cannot tell it.
 */
export function readManifest(rootDir = REPO_ROOT) {
  const manifestPath = path.join(rootDir, MANIFEST_FILE)
  const sidecarPath = path.join(rootDir, SIDECAR_FILE)
  const manifest = readJson(manifestPath)
  const sidecar = readJson(sidecarPath)
  return {
    manifest: mergeSidecar(manifest, sidecar),
    isKit: isKitManifest(manifest),
    sidecar,
    manifestPath,
    sidecarPath,
  }
}
