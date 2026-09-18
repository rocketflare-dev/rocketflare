/**
 * `scripts/release.mjs`'s two testable seams: which repository a release is being cut in, and how
 * one `defaultPlugins` entry is resolved (D31, decision 5).
 *
 * The second is the one that had a bug with teeth. `git ls-remote` proves a ref exists but cannot
 * read a file out of it, so the plugin's declaration came only from an INSTALLED surface — and the
 * kit does not install its own default plugins. Every `pnpm kit:release` was therefore refused with
 * "cannot read" it, which made `--skip-plugin-check` mandatory rather than the loud escape hatch it
 * was written as. Reading the manifest out of the mirror is the fix, and the mirror is injected
 * here so every branch runs with no network at all. What it reads is the top-level `minKit` floor.
 *
 * The `config` project: no database.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MANIFEST_FILE, readManifest } from '../../../../scripts/lib/manifest.mjs'
import type { DefaultPluginEntry, Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  behaviourFiles,
  changelogSection,
  defaultPluginEntries,
  defaultPluginProblems,
  prependChangelogSection,
} from '../../../../scripts/lib/upgrade-lib.mjs'
import type { MirrorReader } from '../../../../scripts/release.d.mts'
import { releaseContext, resolveDefaultPlugin } from '../../../../scripts/release.mjs'

const PLUGIN_MANIFEST = 'rocketflare-plugin.json'
const REPO = 'https://example.test/rocketflare-plugin-orders.git'

const entry = (over: Partial<DefaultPluginEntry> = {}): DefaultPluginEntry => ({
  id: 'orders',
  repo: REPO,
  ref: '1.0.2',
  subdir: '',
  ...over,
})

/** A mirror with a fixed set of refs and a fixed set of files at them. */
const fakeMirror = (
  files: Record<string, string>,
  { refs = ['1.0.2'], latest = '1.0.2' as string | null } = {}
): MirrorReader => ({
  resolves: (ref: string) => refs.includes(ref),
  latestTag: () => latest,
  tryShow: (_ref: string, file: string) =>
    files[file] === undefined ? { ok: false, out: '' } : { ok: true, out: files[file] },
})

const declaring = (minKit: string, version = '1.0.2', at = PLUGIN_MANIFEST) =>
  fakeMirror({ [at]: JSON.stringify({ id: 'orders', version, minKit }) })

/** A plugin still on the OLD shape: a `requires.kit` RANGE and no floor. */
const legacyDeclaring = (requiresKit: string, version = '1.0.2') =>
  fakeMirror({
    [PLUGIN_MANIFEST]: JSON.stringify({ id: 'orders', version, requires: { kit: requiresKit } }),
  })

/** A manifest recording `orders` as installed at an OLDER version than the pin. */
const withInstalled = (minKit: string | null, version = '0.9.0') =>
  ({
    surfaces: [
      { id: 'orders', kind: 'plugin', source: { repo: REPO, version }, minKit, requires: {} },
    ],
  }) as unknown as Manifest

const never = () => {
  throw new Error('the network must not be touched')
}

describe('resolveDefaultPlugin', () => {
  it('reads minKit out of the mirror for a plugin that is NOT installed', () => {
    // The whole bug: nothing is installed here, and the answer is still the plugin's own.
    const resolved = resolveDefaultPlugin(entry(), {
      manifest: null,
      openMirror: () => declaring('0.7.0'),
      lsRemote: never,
    })
    expect(resolved).toEqual({ ok: true, minKit: '0.7.0', legacyRange: null, version: '1.0.2' })
  })

  it('carries a requires.kit RANGE out as legacyRange, and never as a floor', () => {
    // The old shape is not "no floor": the caller names the field and its replacement, which it
    // can only do if the range reaches it. Nothing here reads it as a version bound.
    const resolved = resolveDefaultPlugin(entry(), {
      manifest: null,
      openMirror: () => legacyDeclaring('>=0.6.0 <1.0.0'),
      lsRemote: never,
    })
    expect(resolved).toEqual({
      ok: true,
      minKit: null,
      legacyRange: '>=0.6.0 <1.0.0',
      version: '1.0.2',
    })
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'orders', repo: REPO, ref: '1.0.2' }],
    } as unknown as Manifest)
    expect(defaultPluginProblems(entries, '0.7.0', () => resolved)[0]).toMatch(
      /declares requires\.kit.*"minKit"/
    )
  })

  it('so `kit:release` passes its own gate without --skip-plugin-check', () => {
    // End to end over the pure half: entries → resolver → problems. This is what was impossible.
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'orders', repo: REPO, ref: '1.0.2' }],
    } as unknown as Manifest)
    const resolve = (e: DefaultPluginEntry) =>
      resolveDefaultPlugin(e, { openMirror: () => declaring('0.7.0'), lsRemote: never })
    expect(defaultPluginProblems(entries, '0.7.0', resolve)).toEqual([])
    // …and still refuses a version below the plugin's floor, which is the point of checking.
    expect(defaultPluginProblems(entries, '0.6.0', resolve)[0]).toMatch(
      /needs kit 0\.7\.0 or newer/
    )
  })

  it('reads the manifest from inside a subdirectory when the entry names one', () => {
    const resolved = resolveDefaultPlugin(entry({ subdir: 'packages/orders/' }), {
      openMirror: () => declaring('0.7.0', '2.0.0', `packages/orders/${PLUGIN_MANIFEST}`),
      lsRemote: never,
    })
    expect(resolved).toMatchObject({ ok: true, version: '2.0.0' })
  })

  it('falls back to the newest tag when the entry pins no ref', () => {
    const resolved = resolveDefaultPlugin(entry({ ref: null }), {
      openMirror: () => declaring('0.6.0'),
      lsRemote: never,
    })
    expect(resolved).toMatchObject({ ok: true, minKit: '0.6.0' })
  })

  it('refuses a pin the repository does not have, naming the ref', () => {
    const resolved = resolveDefaultPlugin(entry({ ref: '9.9.9' }), {
      openMirror: () => fakeMirror({}, { refs: ['1.0.2'] }),
      lsRemote: never,
    })
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toMatch(/no '9\.9\.9' in that repository/)
  })

  it('falls back to the installed surface when the ref carries no manifest', () => {
    // An older plugin release may predate the file; that is a missing answer, not a broken plugin.
    const resolved = resolveDefaultPlugin(entry(), {
      manifest: withInstalled('0.5.0'),
      openMirror: () => fakeMirror({}),
      lsRemote: never,
    })
    expect(resolved).toEqual({ ok: true, minKit: '0.5.0', legacyRange: null, version: '0.9.0' })
  })

  it('refuses a manifest that is not JSON — that IS a broken plugin', () => {
    const resolved = resolveDefaultPlugin(entry(), {
      openMirror: () => fakeMirror({ [PLUGIN_MANIFEST]: '{ not json' }),
      lsRemote: never,
    })
    expect(resolved.ok).toBe(false)
    expect(resolved.reason).toMatch(/is not valid JSON/)
  })

  it('degrades to ls-remote plus the installed surface when the mirror cannot be opened', () => {
    // Offline, or a repository this machine cannot reach: prove the ref, report what is recorded.
    const unreachable = () => {
      throw Object.assign(new Error('cannot clone'), { exitCode: 3 })
    }
    expect(
      resolveDefaultPlugin(entry(), {
        manifest: withInstalled('0.5.0'),
        openMirror: unreachable,
        lsRemote: () => true,
      })
    ).toEqual({ ok: true, minKit: '0.5.0', legacyRange: null, version: '0.9.0' })
    // With nothing installed either, the floor is honestly unknown — and the CALLER reports that.
    expect(
      resolveDefaultPlugin(entry(), {
        manifest: null,
        openMirror: unreachable,
        lsRemote: () => true,
      })
    ).toEqual({ ok: true, minKit: null, legacyRange: null, version: null })
    expect(
      resolveDefaultPlugin(entry(), { openMirror: unreachable, lsRemote: () => false }).ok
    ).toBe(false)
  })
})

describe('releaseContext', () => {
  it('agrees with the manifest about which repository this is', () => {
    // Not `toBe('kit')`: this suite travels into every adopted copy, where 'app' is the honest
    // answer and a release here is the app's own business.
    const { isKit } = readManifest()
    expect(releaseContext().kind).toBe(isKit ? 'kit' : 'app')
  })

  it('is "unknown" where there is neither manifest', () => {
    expect(releaseContext('/').kind).toBe('unknown')
  })
})

/**
 * The three repository SHAPES a release can be cut in (D31). The first two must behave exactly as
 * they did before `--plugin` existed, which is what most of these assertions are for; the third is
 * the plugin monorepo `rocketflare-plugins`, whose manifests live in subdirectories and which has
 * none at its root.
 */
describe('releaseContext across repository shapes', () => {
  const scratch: string[] = []
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'rf-release-'))
    scratch.push(root)
    for (const [rel, body] of Object.entries(files)) {
      const file = join(root, rel)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body)
    }
    return root
  }

  const pkg = (version = '1.0.0') => `{\n  "name": "x",\n  "version": "${version}"\n}\n`
  const pluginManifest = (id: string, version = '1.0.0') =>
    `{\n  "id": "${id}",\n  "version": "${version}",\n  "requires": {\n    "kit": ">=0.6.1 <1.0.0",\n    "pluginApi": "1"\n  }\n}\n`

  it('the KIT stamps the root package.json and the kit.version, unchanged', () => {
    const root = repo({
      'package.json': pkg(),
      [MANIFEST_FILE]: `{\n  "kit": {\n    "version": "0.6.1"\n  },\n  "app": null,\n  "surfaces": []\n}\n`,
    })
    const ctx = releaseContext(root)
    expect(ctx.kind).toBe('kit')
    expect(ctx.notesDir).toBe('docs/upgrades')
    expect(ctx.changelog).toBe('CHANGELOG.md')
    expect(ctx.versionFiles?.map(v => v.file)).toEqual(['package.json', MANIFEST_FILE])
    expect(ctx.versionFiles?.map(v => v.label)).toEqual(['version', 'kit.version'])
  })

  it('an APP is refused, whatever else is in it', () => {
    const root = repo({
      'package.json': pkg(),
      [MANIFEST_FILE]: `{\n  "kit": {},\n  "app": { "slug": "acme" },\n  "surfaces": []\n}\n`,
    })
    expect(releaseContext(root).kind).toBe('app')
  })

  it('a SINGLE-plugin repository stamps its manifest then its package.json, unchanged', () => {
    const root = repo({
      'package.json': pkg(),
      [PLUGIN_MANIFEST]: pluginManifest('orders'),
    })
    const ctx = releaseContext(root)
    expect(ctx).toMatchObject({ kind: 'plugin', id: 'orders', notesDir: 'docs/upgrades' })
    expect(ctx.changelog).toBe('CHANGELOG.md')
    expect(ctx.versionFiles?.map(v => v.file)).toEqual([PLUGIN_MANIFEST, 'package.json'])
  })

  describe('a plugin MONOREPO', () => {
    const monorepo = () =>
      repo({
        'package.json': pkg('1.0.2'),
        'CHANGELOG.md': '# Changelog\n\n## Before this repository existed\n',
        [`plugins/analytics/${PLUGIN_MANIFEST}`]: pluginManifest('analytics', '1.0.2'),
        [`plugins/billing/${PLUGIN_MANIFEST}`]: pluginManifest('billing', '1.0.2'),
        // A plugin mirrors the host tree, so its own subdirectories must never be descended into.
        'plugins/analytics/apps/web/src/plugins/analytics/index.ts': 'export {}\n',
        'node_modules/rubbish/rocketflare-plugin.json': '{ "id": "nope" }\n',
      })

    it('is "unknown" at the root — which is the bug --plugin exists to fix', () => {
      expect(releaseContext(monorepo()).kind).toBe('unknown')
    })

    it('resolves against the named subdirectory, with repo-root-relative paths', () => {
      const root = monorepo()
      const ctx = releaseContext(join(root, 'plugins/analytics'), { repoRoot: root })
      expect(ctx).toMatchObject({ kind: 'plugin', id: 'analytics' })
      expect(ctx.notesDir).toBe('plugins/analytics/docs/upgrades')
      // The CHANGELOG is the REPOSITORY's — one index for one lockstep version.
      expect(ctx.changelog).toBe('CHANGELOG.md')
    })

    it('stamps EVERY plugin manifest plus the root package.json (lockstep)', () => {
      // Not cosmetic: `pnpm plugin check` compares an installed surface's recorded version against
      // the anchor manifest, so a manifest left behind makes every install of that plugin report a
      // mismatch. Releasing `analytics` therefore stamps `billing` too.
      const root = monorepo()
      const ctx = releaseContext(join(root, 'plugins/analytics'), { repoRoot: root })
      expect(ctx.versionFiles?.map(v => v.file)).toEqual([
        `plugins/analytics/${PLUGIN_MANIFEST}`,
        `plugins/billing/${PLUGIN_MANIFEST}`,
        'package.json',
      ])
    })

    it('leaves requires.pluginApi alone — a different question from which release shipped it', () => {
      const root = monorepo()
      const ctx = releaseContext(join(root, 'plugins/billing'), { repoRoot: root })
      const { pattern } = ctx.versionFiles?.find(v => v.file.includes('billing')) ?? {}
      const stamped = pluginManifest('billing', '1.0.2').replace(pattern as RegExp, '$1"2.0.0"')
      expect(stamped).toContain('"version": "2.0.0"')
      expect(stamped).toContain('"pluginApi": "1"')
    })
  })
})

describe('the changelog section a release prepends', () => {
  it('renders one entry exactly as it always has', () => {
    expect(
      changelogSection('0.7.0', '2026-09-18', [{ summary: 'A thing.', note: 'd/0.7.0.md' }])
    ).toBe('## 0.7.0 — 2026-09-18\n\nA thing.\n[Porting note](d/0.7.0.md).\n\n')
  })

  it('names each plugin once a release covers more than one', () => {
    const section = changelogSection('2.0.0', '2026-09-18', [
      { id: 'analytics', summary: 'A.', note: 'plugins/analytics/docs/upgrades/2.0.0.md' },
      { id: 'billing', summary: 'B.', note: 'plugins/billing/docs/upgrades/2.0.0.md' },
    ])
    expect(section).toContain('**analytics** — A.')
    expect(section).toContain('**billing** — B.')
  })

  it('goes above the newest section, or at the end when there are none', () => {
    expect(prependChangelogSection('# C\n\n## 0.6.0 — x\n', '## 0.7.0 — y\n\n')).toBe(
      '# C\n\n## 0.7.0 — y\n\n## 0.6.0 — x\n'
    )
    expect(prependChangelogSection('# C\n', '## 0.7.0\n')).toBe('# C\n\n## 0.7.0\n')
  })
})

describe('behaviourFiles scoped to a subdirectory', () => {
  const changed = [
    'plugins/analytics/apps/web/src/plugins/analytics/index.ts',
    'plugins/analytics/docs/upgrades/unreleased.md',
    'plugins/billing/packages/shared/src/plugins/billing/index.ts',
    'apps/web/src/api/index.ts',
    'README.md',
  ]

  it('is unchanged with no scope — the kit and a single-plugin repository', () => {
    expect(behaviourFiles(changed)).toEqual(['apps/web/src/api/index.ts'])
  })

  it("finds a plugin monorepo's source, which the bare predicate cannot see", () => {
    // Without this the gate passes silently on every change, which looks exactly like success.
    expect(behaviourFiles(changed, { within: 'plugins/analytics' })).toEqual([
      'plugins/analytics/apps/web/src/plugins/analytics/index.ts',
    ])
    expect(behaviourFiles(changed, { within: 'plugins/billing/' })).toEqual([
      'plugins/billing/packages/shared/src/plugins/billing/index.ts',
    ])
    // Markdown is still exempt, and the answer is still repo-root-relative.
    expect(behaviourFiles(changed, { within: 'plugins/analytics' })).not.toContain(
      'plugins/analytics/docs/upgrades/unreleased.md'
    )
  })
})
