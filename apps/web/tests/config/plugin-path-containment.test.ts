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
import { classifyPluginFile } from '../../../../scripts/lib/plugin-lib.mjs'

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

/** A throwaway host: the real scripts, manifest and API ledger in a clean git repository. */
function makeHost(name: string, edit?: (manifest: Record<string, unknown>) => void) {
  const host = path.join(root, name, 'host')
  mkdirSync(path.join(host, 'docs'), { recursive: true })
  cpSync(path.join(KIT_ROOT, 'scripts'), path.join(host, 'scripts'), { recursive: true })
  cpSync(path.join(KIT_ROOT, 'package.json'), path.join(host, 'package.json'))
  cpSync(path.join(KIT_ROOT, 'docs/plugin-api.md'), path.join(host, 'docs/plugin-api.md'))
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
