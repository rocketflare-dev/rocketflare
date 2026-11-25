import type { DefaultPluginEntry, Manifest } from './lib/upgrade-lib.mjs'

export const USAGE: string
export const CI_PLUGINS_FILE: string
/** The `plugins` list of `.github/ci-plugins.json` under `root`; `[]` when the file is absent. */
export function readCiPlugins(root?: string): (string | Partial<DefaultPluginEntry>)[]
/** `defaultPlugins` plus the CI-only entries, normalised; an id in both keeps the default's pin. */
export function ciPluginEntries(
  manifest: Partial<Manifest> | null,
  ciPlugins: (string | Partial<DefaultPluginEntry>)[]
): DefaultPluginEntry[]
