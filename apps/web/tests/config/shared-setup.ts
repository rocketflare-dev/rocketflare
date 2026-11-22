/**
 * Setup for the shared-registry `config` project only. Loads the server barrel first, from its own
 * root, the way the app does. A test that imports a plugin module directly enters the plugin
 * cycle from the plugin's side (plugin → `@/plugins/api` → … → the barrel), and the barrel then
 * records that half-loaded plugin as `undefined`. Under a shared registry, that barrel would stay
 * cached for every later file in the worker. `config-isolated` needs none of this, because each
 * file starts clean.
 */
await import('@/plugins/server')

export {}
