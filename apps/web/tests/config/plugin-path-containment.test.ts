/**
 * Every path a plugin or a kit release names stays inside its root: `plugin add`, `plugin upgrade`
 * and `kit:upgrade` refuse it before anything is written, and the plan names what will be written.
 *
 * These run the real scripts over a throwaway host. Plugin and kit trees that carry `..` or `.git`
 * entries cannot be made with ordinary `git add`, so they are assembled with `git mktree`. The
 * `config` project: no database, no network.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { awaitsReprovision, classifyPluginFile } from '../../../../scripts/lib/plugin-lib.mjs'
import { patchTomlFile } from '../../scripts/provision/patch-toml'

const KIT_ROOT = path.resolve(__dirname, '../../../..')

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
}

const git = (cwd: string, args: string[], input?: string) =>
  execFileSync('git', args, { cwd, input, encoding: 'utf8', env: gitEnv }).trim()

let root: string

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rf-path-containment-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** The two tomls, the six barrels and the formatter config `add` runs over them. */
const APP_FILES = [
  'biome.json',
  'apps/web/wrangler.toml',
  'apps/web/wrangler.staging.toml',
  'packages/shared/src/plugins/index.ts',
  'apps/web/src/plugins/server.ts',
  'apps/web/src/plugins/ui.ts',
  'apps/web/src/plugins/schema.ts',
  'apps/web/src/plugins/worker-exports.ts',
  'apps/cli/src/plugins/index.ts',
]

/** A throwaway host: the real scripts, manifest and API ledger in a clean git repository. */
function makeHost(
  name: string,
  edit?: (manifest: Record<string, unknown>) => void,
  files: string[] = []
) {
  const host = path.join(root, name, 'host')
  mkdirSync(path.join(host, 'docs'), { recursive: true })
  for (const file of ['scripts', 'package.json', 'docs/plugin-api.md', ...files]) {
    mkdirSync(path.dirname(path.join(host, file)), { recursive: true })
    cpSync(path.join(KIT_ROOT, file), path.join(host, file), { recursive: true })
  }
  const manifest = JSON.parse(readFileSync(path.join(KIT_ROOT, '.rocketflare.json'), 'utf8'))
  manifest.surfaces = manifest.surfaces.filter((s: { kind?: string }) => s.kind !== 'plugin')
  edit?.(manifest)
  writeFileSync(path.join(host, '.rocketflare.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(path.join(host, '.gitignore'), '.upgrade/\n.rocketflare.local.json\n')
  git(host, ['init', '-q', '-b', 'main'])
  git(host, ['add', '.'])
  git(host, ['commit', '-q', '-m', 'host'])
  return host
}

function run(host: string, script: string, args: string[]) {
  const r = spawnSync(process.execPath, [path.join(host, 'scripts', script), ...args], {
    cwd: host,
    encoding: 'utf8',
    env: gitEnv,
  })
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` }
}

/** A plugin source as a plain directory: the manifest plus `files`. */
function localPlugin(name: string, manifest: object, files: Record<string, string> = {}) {
  const dir = path.join(root, name, 'plugin')
  mkdirSync(dir, { recursive: true })
  const repo = 'https://plugins.example/p.git'
  writeFileSync(
    path.join(dir, 'rocketflare-plugin.json'),
    JSON.stringify({ version: '1.0.0', minKit: '0.1.0', repo, uses: {}, ...manifest }, null, 2)
  )
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  return dir
}

/** Write nested tree objects for `{ 'a/b': blob }` entries; segments may be anything, `..` included. */
function buildTree(bare: string, files: Record<string, string>): string {
  const entries = new Map<string, Record<string, string> | string>()
  for (const [rel, text] of Object.entries(files)) {
    const [head, ...rest] = rel.split('/') as [string, ...string[]]
    if (rest.length === 0) {
      entries.set(head, git(bare, ['hash-object', '-w', '--stdin'], text))
    } else {
      const child = (entries.get(head) as Record<string, string> | undefined) ?? {}
      child[rest.join('/')] = text
      entries.set(head, child)
    }
  }
  const listing = [...entries]
    .map(([name, value]) =>
      typeof value === 'string'
        ? `100644 blob ${value}\t${name}`
        : `040000 tree ${buildTree(bare, value)}\t${name}`
    )
    .join('\n')
  return git(bare, ['mktree'], `${listing}\n`)
}

/** A bare repository with one tagged commit per entry of `releases`, in order. */
function bareRepository(name: string, releases: [string, Record<string, string>][]) {
  const bare = path.join(root, name, 'source.git')
  mkdirSync(bare, { recursive: true })
  git(bare, ['init', '-q', '--bare'])
  let parent: string | null = null
  const commits: Record<string, string> = {}
  for (const [tag, files] of releases) {
    const args = ['commit-tree', buildTree(bare, files), '-m', tag]
    if (parent) args.push('-p', parent)
    parent = git(bare, args)
    commits[tag] = parent
    git(bare, ['update-ref', `refs/tags/${tag}`, parent])
  }
  git(bare, ['update-ref', 'refs/heads/main', parent as string])
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  return { url: `file://${bare}`, commits }
}

describe('plugin add keeps manifest paths inside the plugin', () => {
  it('refuses an anchor outside the plugin roots and writes nothing', () => {
    const host = makeHost('anchor')
    const plugin = localPlugin('anchor', { id: 'orders', anchor: '../outside-anchor/marker.json' })
    const { status, output } = run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(output).toContain('../outside-anchor/marker.json')
    expect(existsSync(path.join(host, '../outside-anchor/marker.json'))).toBe(false)
  })

  it('refuses an anchor elsewhere in the repository', () => {
    const host = makeHost('anchor-core')
    const plugin = localPlugin('anchor-core', { id: 'orders', anchor: 'scripts/plugin.json' })
    const { status } = run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(existsSync(path.join(host, 'scripts/plugin.json'))).toBe(false)
  })

  it('refuses a core edit outside the repository and leaves that file alone', () => {
    const host = makeHost('core')
    const outside = path.join(host, '../outside-core/target.txt')
    mkdirSync(path.dirname(outside), { recursive: true })
    writeFileSync(outside, 'ANCHOR\n')
    const plugin = localPlugin('core', {
      id: 'orders',
      coreEdits: [{ file: '../outside-core/target.txt', after: 'ANCHOR', lines: ['INSERTED'] }],
    })
    const { status } = run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(readFileSync(outside, 'utf8')).toBe('ANCHOR\n')
  })

  it('refuses a core edit under .git', () => {
    const host = makeHost('core-git')
    const before = readFileSync(path.join(host, '.git/config'), 'utf8')
    const plugin = localPlugin('core-git', {
      id: 'orders',
      coreEdits: [{ file: '.git/config', after: '[core]', lines: ['\tfsmonitor = x'] }],
    })
    const { status } = run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(readFileSync(path.join(host, '.git/config'), 'utf8')).toBe(before)
  })

  it('refuses paths and dependency directories that leave the plugin or the repository', () => {
    const host = makeHost('paths')
    const paths = localPlugin('paths', { id: 'orders', paths: ['../elsewhere/**'] })
    expect(run(host, 'plugin.mjs', ['add', paths, '--allow-dirty']).status).toBe(1)
    const core = localPlugin('paths-core', { id: 'orders', paths: ['apps/web/src/api/**'] })
    expect(run(host, 'plugin.mjs', ['add', core, '--allow-dirty']).status).toBe(1)
    const deps = localPlugin('paths-deps', {
      id: 'orders',
      dependencies: { '../elsewhere': { leftpad: '1.0.0' } },
    })
    expect(run(host, 'plugin.mjs', ['add', deps, '--allow-dirty']).status).toBe(1)
  })

  it('refuses a target reached through a symlink, before anything is copied', () => {
    const outside = path.join(root, 'symlink-target')
    mkdirSync(outside, { recursive: true })
    const host = makeHost('symlink')
    symlinkSync(outside, path.join(host, 'docs/plugins'))
    git(host, ['add', '.'])
    git(host, ['commit', '-q', '-m', 'link'])
    const plugin = localPlugin(
      'symlink',
      { id: 'orders' },
      {
        'apps/web/src/plugins/orders/index.ts': 'export {}\n',
        'docs/plugins/orders/readme.md': '# orders\n',
      }
    )
    const { status, output } = run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(output).toContain('docs/plugins')
    expect(existsSync(path.join(outside, 'orders/readme.md'))).toBe(false)
    expect(existsSync(path.join(host, 'apps/web/src/plugins/orders/index.ts'))).toBe(false)
  })

  it('names the anchor in the plan a person approves', () => {
    const host = makeHost('plan')
    const plugin = localPlugin(
      'plan',
      { id: 'orders', anchor: 'apps/web/src/plugins/orders/plugin.json' },
      { 'apps/web/src/plugins/orders/index.ts': 'export {}\n' }
    )
    const { status, output } = run(host, 'plugin.mjs', ['add', plugin, '--allow-dirty'])
    expect(status).toBe(0)
    expect(output).toMatch(/Manifest copy[^\n]*\n\s+apps\/web\/src\/plugins\/orders\/plugin\.json/)
  })
})

describe('plugin add keeps the tree of a release inside the plugin', () => {
  it.each([
    'apps/web/src/plugins/orders/../sibling/index.ts',
    'apps/web/src/plugins/orders/./index.ts',
    'apps/web/src/plugins/orders//index.ts',
    'apps/web/src/plugins/orders/.git/config',
    'apps/web/src/plugins/orders/.GIT/hooks/pre-commit',
    'skills/orders/../other/SKILL.md',
    'docs/upgrades/../../outside.md',
  ])('refuses %s', relPath => {
    expect(classifyPluginFile(relPath, 'orders', { skills: ['orders'] }).role).toBe('refused')
  })

  it('still copies ordinary dotted names and ignores the plugin repository own .git', () => {
    const copied = classifyPluginFile('apps/web/src/plugins/orders/.gitkeep', 'orders')
    expect(copied.role).toBe('copy')
    expect(classifyPluginFile('.git/config', 'orders').role).toBe('repo-only')
  })

  it('refuses a release whose tree climbs out of the host', () => {
    const host = makeHost('tree')
    const climb = Array(6).fill('..').join('/')
    const manifest = JSON.stringify({ id: 'orders', version: '1.0.0', minKit: '0.1.0', uses: {} })
    const { url } = bareRepository('tree', [
      [
        '1.0.0',
        {
          'rocketflare-plugin.json': manifest,
          [`apps/web/src/plugins/orders/${climb}/escaped.txt`]: 'bytes\n',
        },
      ],
    ])
    const { status } = run(host, 'plugin.mjs', ['add', url, '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(existsSync(path.join(host, '../escaped.txt'))).toBe(false)
    expect(existsSync(path.join(host, 'escaped.txt'))).toBe(false)
  })
})

describe('plugin upgrade and remove keep recorded paths inside the plugin', () => {
  const surfaceFor = (url: string | null, commit: string | null, paths: string[]) => ({
    id: 'orders',
    kind: 'plugin',
    label: 'orders',
    anchor: 'apps/web/src/plugins/orders/plugin.json',
    paths,
    registries: [],
    source: { repo: url ?? 'https://plugins.example/p.git', subdir: '', version: '1.0.0', commit },
    installedAt: '2026-01-01',
    minKit: null,
    requires: { surfaces: [], plugins: [] },
    history: [],
  })
  const hostWith = (name: string, surface: object) =>
    makeHost(name, manifest => {
      manifest.app = { slug: 'acme', display: 'Acme', domain: 'acme.example' }
      ;(manifest.surfaces as object[]).push(surface)
    })

  it('remove refuses a recorded directory outside the plugin and deletes nothing', () => {
    const host = hostWith('remove', surfaceFor(null, null, ['../outside-remove/**']))
    const outside = path.join(host, '../outside-remove/kept.txt')
    mkdirSync(path.dirname(outside), { recursive: true })
    writeFileSync(outside, 'kept\n')
    const { status } = run(host, 'plugin.mjs', ['remove', 'orders', '--apply', '--allow-dirty'])
    expect(status).toBe(1)
    expect(readFileSync(outside, 'utf8')).toBe('kept\n')
  })

  it('upgrade refuses a release whose core edit leaves the repository', () => {
    const manifest = (extra: object) =>
      JSON.stringify({ id: 'orders', version: '1.0.0', minKit: '0.1.0', uses: {}, ...extra })
    const { url, commits } = bareRepository('upgrade', [
      ['1.0.0', { 'rocketflare-plugin.json': manifest({}) }],
      [
        '2.0.0',
        {
          'rocketflare-plugin.json': manifest({
            version: '2.0.0',
            coreEdits: [{ file: '../outside-upgrade/t.txt', after: 'ANCHOR', lines: ['X'] }],
          }),
        },
      ],
    ])
    const host = hostWith('upgrade', surfaceFor(url, commits['1.0.0'] as string, []))
    const outside = path.join(host, '../outside-upgrade/t.txt')
    mkdirSync(path.dirname(outside), { recursive: true })
    writeFileSync(outside, 'ANCHOR\n')
    const result = run(host, 'plugin.mjs', [
      'upgrade',
      'orders',
      '--to',
      '2.0.0',
      '--apply',
      '--allow-dirty',
    ])
    expect(result.status).toBe(1)
    expect(result.output).toContain('../outside-upgrade/t.txt')
    expect(readFileSync(outside, 'utf8')).toBe('ANCHOR\n')
  })
})

describe('kit:upgrade keeps every release path inside the repository', () => {
  /** A copy of the kit at 1.0.0 whose kit repository publishes `files` at 2.0.0. */
  function upgradeFixture(name: string, files: Record<string, string>) {
    const { url, commits } = bareRepository(name, [
      ['1.0.0', { 'kept.txt': 'one\n' }],
      ['2.0.0', { 'kept.txt': 'one\n', ...files }],
    ])
    const host = makeHost(name, manifest => {
      manifest.app = { slug: 'acme', display: 'Acme', domain: 'acme.example' }
      manifest.kit = { ...(manifest.kit as object), repo: url, commit: commits['1.0.0'] }
    })
    return host
  }

  it('refuses a release that adds a file under .git and leaves .git alone', () => {
    const host = upgradeFixture('kit-git', { '.git/config': '[core]\n\tfsmonitor = x\n' })
    const before = readFileSync(path.join(host, '.git/config'), 'utf8')
    const { status, output } = run(host, 'upgrade.mjs', ['--apply', '--force'])
    expect(status).toBe(1)
    expect(output).toContain('.git/config')
    expect(readFileSync(path.join(host, '.git/config'), 'utf8')).toBe(before)
  })

  it('refuses a release path that climbs out, on a plan run as well as with --apply', () => {
    const climb = Array(7).fill('..').join('/')
    const host = upgradeFixture('kit-climb', { [`x/${climb}/escaped.txt`]: 'bytes\n' })
    expect(run(host, 'upgrade.mjs', ['--force']).status).toBe(1)
    expect(existsSync(path.join(host, '../escaped.txt'))).toBe(false)
    expect(existsSync(path.join(host, 'escaped.txt'))).toBe(false)
    expect(run(host, 'upgrade.mjs', ['--force', '--apply']).status).toBe(1)
    expect(existsSync(path.join(host, '../escaped.txt'))).toBe(false)
    expect(existsSync(path.join(host, 'escaped.txt'))).toBe(false)
  })

  it('refuses an added file reached through a symlink in this copy', () => {
    const outside = path.join(root, 'kit-symlink-target')
    mkdirSync(outside, { recursive: true })
    const host = upgradeFixture('kit-symlink', { 'link/escaped.txt': 'bytes\n' })
    symlinkSync(outside, path.join(host, 'link'))
    git(host, ['add', '.'])
    git(host, ['commit', '-q', '-m', 'link'])
    const { status } = run(host, 'upgrade.mjs', ['--apply', '--force'])
    expect(status).toBe(1)
    expect(existsSync(path.join(outside, 'escaped.txt'))).toBe(false)
  })

  it('still lands an ordinary added file', () => {
    const host = upgradeFixture('kit-plain', { 'added/file.txt': 'new\n' })
    const { status } = run(host, 'upgrade.mjs', ['--apply', '--force'])
    expect(status).toBe(0)
    expect(readFileSync(path.join(host, 'added/file.txt'), 'utf8')).toBe('new\n')
  })
})

describe('public-site routing across plugins', () => {
  // Fixture ids no real plugin uses, so a host that installs `sites` can still run this suite.
  const TOMLS = ['apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml']
  const tomlsOf = (host: string) => TOMLS.map(f => readFileSync(path.join(host, f), 'utf8'))
  const appHost = (name: string) =>
    makeHost(
      name,
      manifest => {
        manifest.app = { slug: 'acme', display: 'Acme', domain: 'acme.example' }
      },
      APP_FILES
    )
  const sitesPlugin = (name: string) =>
    localPlugin(
      name,
      { id: 'fixture-sites', publicSites: { hostsVar: 'FIXTURE_SITES_HOSTS' }, vars: [{ key: 'FIXTURE_SITES_HOSTS' }] },
      { 'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n' }
    )
  const hooksPlugin = (name: string) =>
    localPlugin(
      name,
      { id: 'fixture-hooks', apiPrefixes: ['/hooks-webhook'] },
      { 'apps/web/src/plugins/fixture-hooks/index.ts': 'export {}\n' }
    )

  it('removing the last public-sites plugin asks for a re-provision, and check fails until then', () => {
    const host = appHost('reprovision')
    for (const plugin of [sitesPlugin('reprovision-a'), hooksPlugin('reprovision-b')]) {
      expect(run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty']).status).toBe(0)
    }

    const removed = run(host, 'plugin.mjs', ['remove', 'fixture-sites', '--apply', '--allow-dirty'])
    expect(removed.status).toBe(0)
    expect(removed.output).toContain('pnpm provision cloudflare')

    const checked = run(host, 'plugin.mjs', ['check'])
    expect(checked.status).toBe(1)
    expect(checked.output).toContain('/hooks-webhook')

    for (const toml of TOMLS) {
      patchTomlFile(path.join(host, toml), { workerFirstPrefixes: ['/hooks-webhook'] })
    }
    expect(tomlsOf(host).some(awaitsReprovision)).toBe(false)
    expect(run(host, 'plugin.mjs', ['check']).status).toBe(0)
  })

  it('removing the plugin whose prefixes were lost takes the mark with it', () => {
    const host = appHost('mark-dropped')
    for (const plugin of [sitesPlugin('mark-dropped-a'), hooksPlugin('mark-dropped-b')]) {
      expect(run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty']).status).toBe(0)
    }
    expect(run(host, 'plugin.mjs', ['remove', 'fixture-sites', '--apply', '--allow-dirty']).status).toBe(0)
    expect(tomlsOf(host).every(awaitsReprovision)).toBe(true)

    expect(run(host, 'plugin.mjs', ['remove', 'fixture-hooks', '--apply', '--allow-dirty']).status).toBe(0)
    expect(tomlsOf(host).some(awaitsReprovision)).toBe(false)
  })

  /** `sites` at 1.0.0 serving no public site, then at 2.0.0 with `second` merged in. */
  const sitesReleases = (name: string, second: object) => {
    const release = (extra: object) => ({
      'rocketflare-plugin.json': JSON.stringify({
        id: 'fixture-sites',
        version: '1.0.0',
        minKit: '0.1.0',
        uses: {},
        ...extra,
      }),
      'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n',
    })
    return bareRepository(name, [
      ['1.0.0', release({})],
      ['2.0.0', release({ version: '2.0.0', ...second })],
    ]).url
  }
  const recordedVersion = (host: string) =>
    JSON.parse(readFileSync(path.join(host, '.rocketflare.json'), 'utf8')).surfaces.find(
      (s: { id: string }) => s.id === 'fixture-sites'
    ).source.version

  it('an upgrade that cannot route one toml writes neither, and stays on the old release', () => {
    const host = appHost('upgrade-routing')
    const url = sitesReleases('upgrade-routing', {
      publicSites: { hostsVar: 'FIXTURE_SITES_HOSTS' },
      vars: [{ key: 'FIXTURE_SITES_HOSTS' }],
    })
    expect(
      run(host, 'plugin.mjs', ['add', `${url}@1.0.0`, '--apply', '--allow-dirty']).status
    ).toBe(0)
    const staging = path.join(host, 'apps/web/wrangler.staging.toml')
    writeFileSync(
      staging,
      readFileSync(staging, 'utf8').replace(/^run_worker_first = \[/m, 'x = [')
    )
    const before = tomlsOf(host)

    const upgraded = run(host, 'plugin.mjs', [
      'upgrade',
      'fixture-sites',
      '--to',
      '2.0.0',
      '--apply',
      '--allow-dirty',
    ])
    expect(upgraded.status).not.toBe(0)
    expect(upgraded.output).toContain('run_worker_first')
    expect(tomlsOf(host)).toEqual(before)
    expect(recordedVersion(host)).toBe('1.0.0')
  })

  it('an upgrade that stops serving public sites asks for a re-provision, as remove does', () => {
    const host = appHost('upgrade-drop')
    const url = bareRepository('upgrade-drop', [
      [
        '1.0.0',
        {
          'rocketflare-plugin.json': JSON.stringify({
            id: 'fixture-sites',
            version: '1.0.0',
            minKit: '0.1.0',
            uses: {},
            publicSites: { hostsVar: 'FIXTURE_SITES_HOSTS' },
            vars: [{ key: 'FIXTURE_SITES_HOSTS' }],
          }),
          'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n',
        },
      ],
      [
        '2.0.0',
        {
          'rocketflare-plugin.json': JSON.stringify({
            id: 'fixture-sites',
            version: '2.0.0',
            minKit: '0.1.0',
            uses: {},
          }),
          'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n',
        },
      ],
    ]).url
    for (const plugin of [`${url}@1.0.0`, hooksPlugin('upgrade-drop-b')]) {
      expect(run(host, 'plugin.mjs', ['add', plugin, '--apply', '--allow-dirty']).status).toBe(0)
    }

    const upgraded = run(host, 'plugin.mjs', [
      'upgrade',
      'fixture-sites',
      '--to',
      '2.0.0',
      '--apply',
      '--allow-dirty',
    ])
    expect(upgraded.output).toContain('pnpm provision cloudflare')
    expect(run(host, 'plugin.mjs', ['check']).status).toBe(1)
  })

  it('an upgrade to a release with an unsafe appOwned path is refused before anything is written', () => {
    const host = appHost('upgrade-appowned')
    const url = sitesReleases('upgrade-appowned', { appOwned: ['..'] })
    expect(
      run(host, 'plugin.mjs', ['add', `${url}@1.0.0`, '--apply', '--allow-dirty']).status
    ).toBe(0)
    const anchor = path.join(host, 'apps/web/src/plugins/fixture-sites/plugin.json')
    const before = readFileSync(anchor, 'utf8')

    const upgraded = run(host, 'plugin.mjs', [
      'upgrade',
      'fixture-sites',
      '--to',
      '2.0.0',
      '--apply',
      '--allow-dirty',
    ])
    expect(upgraded.status).not.toBe(0)
    expect(upgraded.output).toContain('appOwned')
    expect(readFileSync(anchor, 'utf8')).toBe(before)
    expect(recordedVersion(host)).toBe('1.0.0')
  })

  it('an upgrade to a release adding a second images binding is refused before anything is written', () => {
    const host = appHost('upgrade-images')
    const images = { type: 'images', binding: 'IMAGES' }
    const pics = localPlugin(
      'upgrade-images-pics',
      { id: 'pics', bindings: [images] },
      { 'apps/web/src/plugins/pics/index.ts': 'export {}\n' }
    )
    expect(run(host, 'plugin.mjs', ['add', pics, '--apply', '--allow-dirty']).status).toBe(0)
    const url = sitesReleases('upgrade-images', { bindings: [images] })
    expect(
      run(host, 'plugin.mjs', ['add', `${url}@1.0.0`, '--apply', '--allow-dirty']).status
    ).toBe(0)

    const upgraded = run(host, 'plugin.mjs', [
      'upgrade',
      'fixture-sites',
      '--to',
      '2.0.0',
      '--apply',
      '--allow-dirty',
    ])
    expect(upgraded.status).not.toBe(0)
    expect(upgraded.output).toContain("'pics' already has one")
    expect(recordedVersion(host)).toBe('1.0.0')
  })

  it('remove reports an appOwned file replaced by a directory symlink, rather than crashing', () => {
    const host = appHost('remove-symlink')
    const app = 'apps/web/src/plugins/fixture-sites/app'
    const { url } = bareRepository('remove-symlink', [
      [
        '1.0.0',
        {
          'rocketflare-plugin.json': JSON.stringify({
            id: 'fixture-sites',
            version: '1.0.0',
            minKit: '0.1.0',
            uses: {},
            appOwned: [app],
          }),
          'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n',
          [`${app}/page.txt`]: 'page\n',
        },
      ],
    ])
    expect(
      run(host, 'plugin.mjs', ['add', `${url}@1.0.0`, '--apply', '--allow-dirty']).status
    ).toBe(0)
    const target = path.join(root, 'remove-symlink', 'target')
    mkdirSync(target, { recursive: true })
    rmSync(path.join(host, app, 'page.txt'))
    symlinkSync(target, path.join(host, app, 'page.txt'))

    const planned = run(host, 'plugin.mjs', ['remove', 'fixture-sites', '--allow-dirty'])
    expect(planned.output).not.toContain('EISDIR')
    expect(planned.status).toBe(0)
    expect(planned.output).toMatch(new RegExp(`changed\\s+${app}/page\\.txt`))
  })

  it('remove lists an appOwned directory replaced by a symlink as one entry, not its target', () => {
    const host = appHost('remove-root-symlink')
    const app = 'apps/web/src/plugins/fixture-sites/app'
    const { url } = bareRepository('remove-root-symlink', [
      [
        '1.0.0',
        {
          'rocketflare-plugin.json': JSON.stringify({
            id: 'fixture-sites',
            version: '1.0.0',
            minKit: '0.1.0',
            uses: {},
            appOwned: [app],
          }),
          'apps/web/src/plugins/fixture-sites/index.ts': 'export {}\n',
          [`${app}/page.txt`]: 'page\n',
        },
      ],
    ])
    expect(
      run(host, 'plugin.mjs', ['add', `${url}@1.0.0`, '--apply', '--allow-dirty']).status
    ).toBe(0)
    const target = path.join(root, 'remove-root-symlink', 'target')
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, 'elsewhere.txt'), 'not the plugin\n')
    rmSync(path.join(host, app), { recursive: true })
    symlinkSync(target, path.join(host, app))

    const planned = run(host, 'plugin.mjs', ['remove', 'fixture-sites', '--allow-dirty'])
    expect(planned.status).toBe(0)
    expect(planned.output).not.toContain('elsewhere.txt')
    expect(planned.output).toMatch(new RegExp(`added\\s+${app}\\n`))
  })

  it('a prefix not yet provisioned is the next step of add, not a check failure', () => {
    const host = appHost('unprovisioned')
    const added = run(host, 'plugin.mjs', [
      'add',
      hooksPlugin('unprovisioned-b'),
      '--apply',
      '--allow-dirty',
    ])
    expect(added.status).toBe(0)
    expect(run(host, 'plugin.mjs', ['check']).status).toBe(0)
  })
})
