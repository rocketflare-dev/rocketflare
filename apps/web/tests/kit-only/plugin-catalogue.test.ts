/**
 * `pnpm plugin list --available`: the catalogue of published plugins, read live from their
 * repositories at the newest release tag.
 *
 * Two halves, like `plugin-skills.test.ts`. The parsing and printing are pure functions over
 * fixture trees. The command runs the real `scripts/plugin.mjs` in a throwaway host against
 * LOCAL bare repositories (`PLUGIN_CATALOGUES` points it at them), so nothing here reaches the
 * network — including the failure cases, which delete the repository the mirror was cloned from.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  catalogueEntries,
  catalogueJson,
  catalogueReads,
  licenceTerms,
  PLUGIN_CATALOGUE_URL,
  PLUGIN_CATALOGUES,
  PLUGIN_MANIFEST_FILE,
  readmeLede,
  renderCatalogue,
  repoDisplayName,
} from '../../../../scripts/lib/plugin-lib.mjs'
import type { Surface } from '../../../../scripts/lib/upgrade-lib.d.mts'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const manifest = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, label: id[0].toUpperCase() + id.slice(1), version: '3.1.0', ...extra })

/** A tree as `{ path: text }`, read the way the command reads a mirror. */
const reader = (tree: Record<string, string>) => (rel: string) => tree[rel] ?? null

const MONOREPO: Record<string, string> = {
  'package.json': '{}',
  [`plugins/orders/${PLUGIN_MANIFEST_FILE}`]: manifest('orders'),
  'plugins/orders/README.md':
    '# orders\n\n> Orders for your app, with [`invoices`](../invoices/) and\n> refunds.\n\nMore.\n',
  [`plugins/invoices/${PLUGIN_MANIFEST_FILE}`]: manifest('invoices', {
    description: 'Invoices, from the manifest.',
  }),
  'plugins/invoices/README.md': '# invoices\n\n> Not this one.\n',
  [`plugins/bare/${PLUGIN_MANIFEST_FILE}`]: manifest('bare'),
  // A plugin's own tree mirrors a host, so a manifest inside it is not a second plugin.
  [`plugins/bare/apps/web/src/plugins/bare/${PLUGIN_MANIFEST_FILE}`]: manifest('nested'),
  [`plugins/broken/${PLUGIN_MANIFEST_FILE}`]: '{ not json',
  [`plugins/badid/${PLUGIN_MANIFEST_FILE}`]: manifest('Bad Id'),
}
const files = Object.keys(MONOREPO).sort()

const surface = (id: string, version: string) =>
  ({ id, kind: 'plugin', source: { version } }) as unknown as Surface

// ---------------------------------------------------------------- the pure half

describe('the catalogue sources', () => {
  it('are the published first-party and commercial repositories, in that order', () => {
    expect(PLUGIN_CATALOGUES.map(c => repoDisplayName(c.repo))).toEqual([
      'github.com/rocketflare-dev/rocketflare-plugins',
      'github.com/rocketflare-dev/rocketflare-commercial-plugins',
    ])
    expect(PLUGIN_CATALOGUES.map(c => c.commercial)).toEqual([false, true])
    expect(PLUGIN_CATALOGUE_URL).toBe('https://rocketflare.dev/plugins')
  })
})

describe('a README lede', () => {
  it('is the opening blockquote, on one line, without link targets or code ticks', () => {
    expect(readmeLede(MONOREPO['plugins/orders/README.md'])).toBe(
      'Orders for your app, with invoices and refunds.'
    )
  })

  it('is the first sentence of the first paragraph when there is no blockquote', () => {
    expect(
      readmeLede('# sites\n\nPublic websites from your app. Pages in **several**\nlanguages.\n')
    ).toBe('Public websites from your app.')
    expect(readmeLede('# only a title\n')).toBeNull()
    expect(readmeLede(null)).toBeNull()
  })
})

describe('catalogueEntries', () => {
  it('finds each plugin once, sorted, describing it from its manifest, else its README, else its label', () => {
    expect(catalogueEntries(files, reader(MONOREPO))).toEqual([
      { id: 'bare', label: 'Bare', version: '3.1.0', subdir: 'plugins/bare', description: 'Bare' },
      {
        id: 'invoices',
        label: 'Invoices',
        version: '3.1.0',
        subdir: 'plugins/invoices',
        description: 'Invoices, from the manifest.',
      },
      {
        id: 'orders',
        label: 'Orders',
        version: '3.1.0',
        subdir: 'plugins/orders',
        description: 'Orders for your app, with invoices and refunds.',
      },
    ])
  })

  it('reads a single-plugin repository from its root', () => {
    const tree = { [PLUGIN_MANIFEST_FILE]: manifest('orders'), 'README.md': '# o\n\n> Orders.\n' }
    expect(catalogueEntries(Object.keys(tree), reader(tree))).toEqual([
      { id: 'orders', label: 'Orders', version: '3.1.0', subdir: '', description: 'Orders.' },
    ])
  })

  it('names every file it may read, so the mirror can fetch them in one round trip', () => {
    expect(catalogueReads([...files, 'LICENSE', 'plugins/orders/index.ts']).sort()).toEqual(
      [
        'LICENSE',
        `plugins/badid/${PLUGIN_MANIFEST_FILE}`,
        `plugins/bare/${PLUGIN_MANIFEST_FILE}`,
        `plugins/bare/apps/web/src/plugins/bare/${PLUGIN_MANIFEST_FILE}`,
        `plugins/broken/${PLUGIN_MANIFEST_FILE}`,
        'plugins/invoices/README.md',
        `plugins/invoices/${PLUGIN_MANIFEST_FILE}`,
        'plugins/orders/README.md',
        `plugins/orders/${PLUGIN_MANIFEST_FILE}`,
      ].sort()
    )
  })
})

describe('licenceTerms', () => {
  const where = { repo: 'https://github.com/example-org/paid.git', ref: '1.2.0' }

  it('points at the LICENSE, else a Licence section of the README, else nothing', () => {
    expect(licenceTerms(['LICENSE'], reader({ LICENSE: 'Terms.' }), where)).toEqual({
      file: 'LICENSE',
      url: 'https://github.com/example-org/paid/blob/1.2.0/LICENSE',
    })
    expect(
      licenceTerms(['README.md'], reader({ 'README.md': '# Paid\n\n## Licence\n\nAsk.' }), where)
    ).toEqual({
      file: 'README.md',
      url: 'https://github.com/example-org/paid/blob/1.2.0/README.md',
    })
    expect(licenceTerms(['README.md'], reader({ 'README.md': '# Paid\n' }), where)).toBeNull()
    expect(licenceTerms(['LICENSE'], reader({ LICENSE: '  ' }), where)).toBeNull()
  })
})

describe('the printed catalogue', () => {
  const open = {
    repo: 'https://github.com/example-org/plugins.git',
    tag: '3.1.0',
    commercial: false,
    plugins: catalogueEntries(files, reader(MONOREPO)),
  }
  const paid = {
    repo: 'https://github.com/example-org/paid.git',
    tag: '0.2.0',
    commercial: true,
    licence: null,
    plugins: [
      {
        id: 'sites',
        label: 'Sites',
        version: '0.2.0',
        subdir: 'plugins/sites',
        description: 'Sites.',
      },
    ],
  }

  it('is one line per plugin — id, version, installed here or not, description', () => {
    const lines = renderCatalogue([open], [surface('orders', '3.1.0'), surface('bare', '3.0.0')])
    expect(lines[0]).toBe('Plugins (github.com/example-org/plugins at 3.1.0)')
    expect(lines.find(l => l.trim().startsWith('orders'))).toMatch(
      /^ {2}orders +3\.1\.0 +installed +Orders for your app, with invoices and refunds\.$/
    )
    expect(lines.find(l => l.trim().startsWith('bare'))).toMatch(/installed 3\.0\.0 +Bare$/)
    expect(lines.find(l => l.trim().startsWith('invoices'))).not.toMatch(/installed/)
    expect(lines.join('\n')).toContain(PLUGIN_CATALOGUE_URL)
    expect(lines.join('\n')).not.toMatch(/[Cc]ommercial/)
  })

  it('puts commercial plugins under their own heading, with where their terms are', () => {
    const text = renderCatalogue([open, paid]).join('\n')
    expect(text).toMatch(/Commercial plugins \(github\.com\/example-org\/paid at 0\.2\.0\)/)
    expect(text).toContain('licence: ask the maintainers')
    const licensed = { ...paid, licence: { file: 'LICENSE', url: 'https://x.test/LICENSE' } }
    expect(renderCatalogue([licensed]).join('\n')).toContain('licence: https://x.test/LICENSE')
  })

  it('carries the same facts as JSON', () => {
    const json = catalogueJson([open, paid], [surface('orders', '3.1.0')]) as {
      catalogues: { commercial: boolean; plugins: { id: string; installed: boolean }[] }[]
    }
    expect(json.catalogues.map(c => c.commercial)).toEqual([false, true])
    expect(json.catalogues[0].plugins.map(p => [p.id, p.installed])).toEqual([
      ['bare', false],
      ['invoices', false],
      ['orders', true],
    ])
  })
})

// ---------------------------------------------------------------- the command

const sandboxes: string[] = []
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// An identity of its own: CI runners have none, and an annotated tag needs one as a commit does.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
}
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY },
  })

function write(root: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

function sandbox(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  sandboxes.push(dir)
  return dir
}

/** A host the script can run in: this checkout's scripts and manifest, in a fresh git repo. */
function makeHostOnce() {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-catalogue-host-'))
  cpSync(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), {
    recursive: true,
    filter: src => !src.includes(`${path.sep}.upgrade`),
  })
  write(root, 'package.json', readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const m = JSON.parse(readFileSync(path.join(REPO_ROOT, '.rocketflare.json'), 'utf8'))
  m.surfaces = m.surfaces.filter((s: { kind?: string }) => s.kind !== 'plugin')
  write(root, '.rocketflare.json', `${JSON.stringify(m, null, 2)}\n`)
  write(root, '.gitignore', '.upgrade/\n')
  git(root, ['init', '-q'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'host'])
  return root
}

/** A plugin repository holding `tree`, with each of `tags` cut at the same commit. */
function makeRepo(tree: Record<string, string>, tags: string[]) {
  const root = sandbox('rf-catalogue-repo-')
  git(root, ['init', '-q'])
  for (const [rel, text] of Object.entries(tree)) write(root, rel, text)
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'release'])
  for (const t of tags) git(root, ['tag', '-a', '-m', t, t])
  return root
}

const run = (host: string, args: string[], sources: { repo: string; commercial?: boolean }[]) => {
  try {
    const out = execFileSync('node', [path.join(host, 'scripts/plugin.mjs'), ...args], {
      cwd: host,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLUGIN_CATALOGUES: JSON.stringify(sources) },
    })
    return { status: 0, out, err: '' }
  } catch (error) {
    const e = error as { status: number; stdout?: string; stderr?: string }
    return { status: e.status, out: e.stdout ?? '', err: e.stderr ?? '' }
  }
}

describe('plugin list --available', () => {
  // One host for the block: every repository below is its own temp dir, so its mirror is too.
  let shared: string | null = null
  const makeHost = () => {
    shared ??= makeHostOnce()
    return shared
  }
  afterAll(() => {
    if (shared) rmSync(shared, { recursive: true, force: true })
  })

  it('reads each repository at its newest tag and prints the commercial one under its heading', () => {
    const host = makeHost()
    const open = makeRepo(MONOREPO, ['3.0.0', '3.1.0', 'not-a-release'])
    const paid = makeRepo(
      {
        LICENSE: 'All rights reserved.',
        [`plugins/sites/${PLUGIN_MANIFEST_FILE}`]: manifest('sites', { version: '0.2.0' }),
      },
      ['0.2.0']
    )
    const r = run(host, ['list', '--available'], [{ repo: open }, { repo: paid, commercial: true }])
    expect(r.status, r.err).toBe(0)
    expect(r.out).toContain(`Plugins (${open} at 3.1.0)`)
    expect(r.out).toMatch(/^ {2}orders +3\.1\.0 +Orders for your app/m)
    expect(r.out).toMatch(/Commercial plugins .* at 0\.2\.0\)/)
    expect(r.out).toMatch(/^ {2}sites +0\.2\.0/m)

    const json = run(host, ['list', '--available', '--json'], [{ repo: open }])
    expect(json.status).toBe(0)
    expect(JSON.parse(json.out).catalogues[0].plugins.map((p: { id: string }) => p.id)).toEqual([
      'bare',
      'invoices',
      'orders',
    ])
  })

  it('says nothing at all about a commercial repository it cannot read', () => {
    const host = makeHost()
    const open = makeRepo(MONOREPO, ['3.1.0'])
    const missing = path.join(sandbox('rf-catalogue-none-'), 'paid')
    const r = run(
      host,
      ['list', '--available'],
      [{ repo: open }, { repo: missing, commercial: true }]
    )
    expect(r.status).toBe(0)
    expect(`${r.out}${r.err}`).not.toMatch(/[Cc]ommercial|paid/)
  })

  it('fails in one line, exit 3, when the repository cannot be read — never from the cache', () => {
    const host = makeHost()
    const open = makeRepo(MONOREPO, ['3.1.0'])
    expect(run(host, ['list', '--available'], [{ repo: open }]).status).toBe(0)
    // The mirror is cached now; the source going away must still be a failure, not a stale list.
    rmSync(open, { recursive: true, force: true })
    const r = run(host, ['list', '--available'], [{ repo: open }])
    expect(r.status).toBe(3)
    expect(r.out).toBe('')
    expect(r.err.trim().split('\n')).toHaveLength(1)
    expect(r.err).toMatch(/^error: cannot read the plugin catalogue/)
    expect(run(host, ['list', '--available', '--no-fetch'], [{ repo: open }]).status).toBe(2)
  })
})
