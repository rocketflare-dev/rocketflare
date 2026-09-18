/**
 * The plugin API version (D31) — the pin between its two copies, and the one comparison.
 *
 * `PLUGIN_API` lives in `packages/shared/src/plugins/contract.ts` and is mirrored into
 * `.rocketflare.json`, because `scripts/*.mjs` runs under plain Node and cannot import a `.ts`
 * module — the same trade `SUPPORTED_PLUGIN_BINDING_TYPES` already lives with. A duplication that
 * nothing pins is a duplication that drifts, and this one drifting means the tooling refusing
 * installs the kit would accept, or accepting ones it should not: the surface would say one number
 * and `plugin add` another, with nothing to say which was right.
 *
 * What is deliberately NOT here: regenerating `docs/plugin-api.md`. That needs a TypeScript program
 * over every declared entry, and it is diff-checked in CI beside `worker-configuration.d.ts` for
 * exactly the reason that file is — a generated artefact that is committed and diff-checked cannot
 * drift. This suite asserts the cheap, stable half: that the document exists and records the
 * version the source says. The `config` project has no database and no network.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PLUGIN_API } from '@rocketflare/shared/plugins/contract'
import { describe, expect, it } from 'vitest'
import manifest from '../../../../.rocketflare.json'
import { readManifest } from '../../../../scripts/lib/manifest.mjs'
import {
  pluginApiNote,
  pluginApiProblem,
  readPluginApi,
  toInteger,
} from '../../../../scripts/lib/plugin-api.mjs'
import { pluginApiDeclaration, staticImports } from '../helpers/plugins'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

describe('PLUGIN_API', () => {
  it('is mirrored exactly into .rocketflare.json', () => {
    expect(manifest.kit.pluginApi).toEqual({
      current: PLUGIN_API.current,
      minSupported: PLUGIN_API.minSupported,
    })
  })

  it('is two whole numbers, and minSupported never exceeds current', () => {
    expect(Number.isInteger(PLUGIN_API.current)).toBe(true)
    expect(Number.isInteger(PLUGIN_API.minSupported)).toBe(true)
    expect(PLUGIN_API.minSupported).toBeLessThanOrEqual(PLUGIN_API.current)
  })

  /**
   * The leaf imports nothing at all, which is stronger than the rule it has to obey.
   * `packages/shared/src/plugins/**` may not import one of the five composers at RUNTIME, because
   * those read the plugin barrel and two zod modules in a cycle crash at module evaluation rather
   * than failing to compile. A module with no imports cannot be in any cycle, and this constant is
   * read by the tooling, the tests and a plugin's own contract alike.
   */
  it('imports nothing, so it can never be part of a cycle', () => {
    expect(staticImports(read('packages/shared/src/plugins/contract.ts'))).toEqual([])
  })
})

describe('reading the version out of a manifest', () => {
  it('reads the mirror', () => {
    expect(readPluginApi(manifest)).toEqual({
      current: PLUGIN_API.current,
      minSupported: PLUGIN_API.minSupported,
    })
  })

  /**
   * A copy of the kit made before this field existed has no `kit.pluginApi`, and version 1 is
   * exactly what such a copy had. Defaulting is a statement of fact rather than a guess, and it is
   * what keeps `plugin add` working in a copy that has not taken this release yet.
   */
  it('defaults to 1 for a manifest written before the field existed', () => {
    expect(readPluginApi({ kit: {} })).toEqual({ current: 1, minSupported: 1 })
    expect(readPluginApi(null)).toEqual({ current: 1, minSupported: 1 })
  })
})

describe('the comparison', () => {
  const api = { current: 3, minSupported: 2 }

  it('accepts a whole number in either spelling', () => {
    expect(toInteger('2')).toBe(2)
    expect(toInteger(2)).toBe(2)
    expect(pluginApiProblem('2', api)).toBeNull()
    expect(pluginApiProblem(3, api)).toBeNull()
  })

  /**
   * The point of the whole design: there is no range language, so there is no malformed range to
   * throw out of a matcher and arrive as a generic failure with nothing to act on. Every one of
   * these is one sentence naming the fix.
   */
  it('refuses anything that is not a whole number, without any range language', () => {
    for (const bad of ['2.0', '>=2', '^2', 'two', '~2.1', {}]) {
      expect(pluginApiProblem(bad, api), String(bad)).toMatch(/is not a whole number/)
    }
    expect(pluginApiProblem('>=2', api)).not.toMatch(/satisf/i)
  })

  it('names the direction: too new needs a kit, too old needs migrating', () => {
    expect(pluginApiProblem(4, api)).toMatch(/newer than this kit's plugin API 3/)
    expect(pluginApiProblem(4, api)).toMatch(/upgrade the kit/)
    expect(pluginApiProblem(1, api)).toMatch(/older than this kit supports/)
    expect(pluginApiProblem(1, api)).toMatch(/needs migrating/)
  })

  /**
   * Undeclared is warned, never failed — and this is the assertion that keeps it that way. The
   * kit's own second CI pass installs `analytics` 1.0.2, which predates the plugin API entirely and
   * cannot retroactively declare anything. A stricter reading here would break the install of a
   * released plugin nobody can change.
   */
  it('says nothing about a plugin that declares no version', () => {
    for (const absent of [undefined, null, '', '   ']) {
      expect(pluginApiProblem(absent, api), String(absent)).toBeNull()
    }
    expect(pluginApiNote(undefined, api).level).toBe('warn')
    expect(pluginApiNote(undefined, api).message).toMatch(/declares no requires\.pluginApi/)
    expect(pluginApiNote(2, api).level).toBe('ok')
    expect(pluginApiNote(9, api).level).toBe('error')
  })
})

/**
 * Whatever is installed HERE, rather than the reference plugin by name: an app is expected to
 * delete `example-feature`, and this suite travels into every app with the rest of the kit's.
 */
describe('the plugins installed in this checkout', () => {
  const installed = (readManifest().manifest?.surfaces ?? []).filter(
    (s: { kind: string }) => s.kind === 'plugin'
  ) as Array<{ id: string }>

  it('declare a plugin API version this kit accepts, or none at all', () => {
    for (const surface of installed) {
      const declared = pluginApiDeclaration(REPO_ROOT, surface.id)
      expect(pluginApiProblem(declared, PLUGIN_API), surface.id).toBeNull()
    }
  })
})

describe('docs/plugin-api.md', () => {
  it('exists — it is the contract a plugin author reads', () => {
    expect(existsSync(path.join(REPO_ROOT, 'docs/plugin-api.md'))).toBe(true)
  })

  /**
   * The ledger's version is what the generator compares the next surface change against, so a
   * document recording a different number from the source would silently disable the check that
   * makes the version mean anything.
   */
  it('records the version the source declares', () => {
    expect(read('docs/plugin-api.md')).toContain(`plugin-api ${PLUGIN_API.current}`)
  })
})
