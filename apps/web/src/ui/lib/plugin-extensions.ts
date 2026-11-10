/**
 * The UI half of the cross-plugin registries (`UiPlugin.extensions`), mirroring
 * `ServerPlugin.extensions` and `extensions()` in `@/plugins/api/peers`: every installed plugin's
 * entries under a key, in barrel order. `unknown` on purpose — the plugin that OWNS the key
 * narrows them with its own schema and refuses what does not parse; the host never learns what an
 * entry means.
 */
import { uiPlugins } from '@/plugins/ui'

export function uiExtensions(key: string): readonly unknown[] {
  return uiPlugins.flatMap(p => p.extensions?.[key] ?? [])
}

/** Which plugins contributed under a key — for the error message when one of them does not parse. */
export function uiExtensionSources(key: string): readonly string[] {
  return uiPlugins.filter(p => (p.extensions?.[key]?.length ?? 0) > 0).map(p => p.shared.id)
}
