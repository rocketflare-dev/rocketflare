/**
 * Kit-only: `tests/config/patch-toml.test.ts` runs the patcher on a SNAPSHOT of the kit's tomls
 * (`tests/config/fixtures/wrangler{,.staging}.toml`), because in a copy the files on disk are
 * already provisioned. Here, in the kit, the snapshot must still be the shipped tomls byte for byte
 * (after its two-line FIXTURE header), so a change to the tomls' shape reaches the patcher's tests.
 * Changed a toml? Copy it over its snapshot and keep the header.
 *
 * Skipped once any plugin but the vendored `example-feature` is installed (kit.yml's "Gate with the
 * CI plugins"): `plugin add` writes that plugin's bindings, crons and route prefixes into the
 * tomls, so they are no longer the ones the kit ships.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const WEB_DIR = path.resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(path.join(WEB_DIR, rel), 'utf8')

const VENDORED_PLUGINS = new Set(['example-feature'])
const installedPlugins = ['.rocketflare.json', '.rocketflare.local.json']
  .map(f => path.join(WEB_DIR, '../..', f))
  .filter(f => existsSync(f))
  .flatMap(
    f => (JSON.parse(readFileSync(f, 'utf8')).surfaces ?? []) as { id: string; kind?: string }[]
  )
  .filter(s => s.kind === 'plugin' && !VENDORED_PLUGINS.has(s.id))

it.skipIf(installedPlugins.length > 0).each(['wrangler.toml', 'wrangler.staging.toml'])(
  'the patcher tests snapshot %s as the kit ships it',
  file => {
    const snapshot = read(`tests/config/fixtures/${file}`)
    expect(snapshot.split('\n').slice(0, 2).join('\n')).toMatch(/^# FIXTURE[^\n]*\n# /)
    expect(snapshot.split('\n').slice(2).join('\n')).toBe(read(file))
  }
)
