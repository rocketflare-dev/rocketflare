/**
 * Porting-note FRAGMENTS (`docs/upgrades/unreleased/<slug>.md`, `docs/upgrades/README.md`): one
 * file per pull request, so parallel pull requests stop conflicting in a single `unreleased.md`.
 *
 * Four halves, each with its own seam: the fragment schema (`fragmentProblems`), the fold a
 * release performs (`mergeNotes`), the checks that require a note (`unreleasedVerdict`,
 * `recordsPortingNote`), and `scripts/release.mjs` end to end on a throwaway kit — the legacy file
 * plus two fragments in, one note that passes the tag gate out.
 *
 * The `kit-only` project: no database.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fragmentProblems,
  fragmentRank,
  isFragmentPath,
  noteProblems,
  parseNote,
  recordsPortingNote,
} from '../../../../scripts/lib/upgrade-lib.mjs'
import { listItems, mergeNotes } from '../../../../scripts/release.mjs'
import { listFragments, unreleasedVerdict } from '../../../../scripts/release-check.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

const fragment = ({
  front = 'breaking: false\nmigrations: []\nareas: [api]\ntouches_surfaces: []\nrequires_surfaces: []\nmanual: false',
  changed = 'A summary sentence.\n\n- A bullet.',
  apply = '- Do the thing.',
  conflicts = 'None.',
  verify = '- `pnpm test config` passes.\n- `pnpm gate` passes.',
} = {}) =>
  `---\n${front}\n---\n\n## What changed\n\n${changed}\n\n## How to apply\n\n${apply}\n\n## Conflicts to expect\n\n${conflicts}\n\n## Verify\n\n${verify}\n`

const LEGACY = `---
version: unreleased
previous: 0.1.0
date: null
breaking: false
migrations: ["a column on agent_runs"]
areas: [api, ui]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

The legacy summary.

- Legacy bullet one.
- Legacy bullet two.

## How to apply

1. Legacy step one.
2. Legacy step two, which wraps
   onto a second line.

## Conflicts to expect

- \`apps/web/src/x.ts\` → changed → take the kit's.

## Verify

1. Legacy check.
2. \`pnpm gate\` passes.
`

describe('the fragment schema', () => {
  const check = (text: string, file = 'docs/upgrades/unreleased/my-change.md') =>
    fragmentProblems(text, { file, surfaceIds: ['feature-chat'] })

  it('passes a well-formed fragment, with or without an order', () => {
    expect(check(fragment())).toEqual([])
    for (const order of ['first', 'last', '-1', '10']) {
      const front = `order: ${order}\nbreaking: false\nmigrations: []\nareas: []\ntouches_surfaces: []\nrequires_surfaces: []\nmanual: false`
      expect(check(fragment({ front })), order).toEqual([])
    }
  })

  it('holds the frontmatter to the same rules as a note', () => {
    const problems = check(
      fragment({
        front:
          'breaking: maybe\nmigrations: ["0012_x.sql"]\nareas: api\ntouches_surfaces: [nope]\nrequires_surfaces: []\nmanual: false',
      })
    )
    expect(problems.join('\n')).toMatch(/breaking must be true or false/)
    expect(problems.join('\n')).toMatch(/describe the change/)
    expect(problems.join('\n')).toMatch(/areas must be a list/)
    expect(problems.join('\n')).toMatch(/touches_surfaces names 'nope'/)
  })

  it('refuses the fields only a release writes, unknown fields and a bad order', () => {
    const base =
      'breaking: false\nmigrations: []\nareas: []\ntouches_surfaces: []\nrequires_surfaces: []\nmanual: false'
    expect(check(fragment({ front: `version: 0.2.0\n${base}` }))[0]).toMatch(
      /carries 'version' — a fragment has none/
    )
    expect(check(fragment({ front: `previous: 0.1.0\n${base}` }))[0]).toMatch(/carries 'previous'/)
    expect(check(fragment({ front: `colour: red\n${base}` }))[0]).toMatch(
      /'colour' is not a fragment field/
    )
    expect(check(fragment({ front: `order: soon\n${base}` }))[0]).toMatch(
      /order is 'soon', expected first, last or an integer/
    )
  })

  it('wants exactly the four headings, a summary, steps and checks', () => {
    expect(check(fragment({ changed: '' })).join('\n')).toMatch(/'## What changed' is empty/)
    expect(check(fragment({ apply: '' })).join('\n')).toMatch(/'## How to apply' is empty/)
    expect(check(fragment({ verify: '' })).join('\n')).toMatch(/'## Verify' is empty/)
    expect(check(fragment({ changed: 'Summary.\n\n### A chapter' })).join('\n')).toMatch(
      /sub-heading/
    )
    expect(check(`${fragment()}\n## Notes\n\nx\n`).join('\n')).toMatch(
      /'## Notes' is not one of the four headings/
    )
    expect(check(fragment().replace('## Verify', '## Checks')).join('\n')).toMatch(
      /missing the '## Verify' heading/
    )
  })

  it('wants a short kebab-case filename', () => {
    expect(check(fragment(), 'docs/upgrades/unreleased/My_Change.md')[0]).toMatch(/kebab-case/)
    expect(check('no frontmatter')).toEqual([
      'docs/upgrades/unreleased/my-change.md: no YAML frontmatter',
    ])
  })

  it('ranks an order: first, integers, absent (0), last', () => {
    expect(fragmentRank('first')).toBe(Number.NEGATIVE_INFINITY)
    expect(fragmentRank(undefined)).toBe(0)
    expect(fragmentRank('-2')).toBe(-2)
    expect(fragmentRank('last')).toBe(Number.POSITIVE_INFINITY)
    expect(fragmentRank('soon')).toBeNull()
  })
})

describe('what counts as a fragment, and as carrying a note', () => {
  it('is a markdown file directly under unreleased/, never its README', () => {
    expect(isFragmentPath('docs/upgrades/unreleased/x-y.md')).toBe(true)
    expect(isFragmentPath('docs/upgrades/unreleased/README.md')).toBe(false)
    expect(isFragmentPath('docs/upgrades/unreleased/a/b.md')).toBe(false)
    expect(isFragmentPath('docs/upgrades/unreleased.md')).toBe(false)
    expect(isFragmentPath('docs/upgrades/0.46.0.md')).toBe(false)
    expect(
      isFragmentPath('plugins/a/docs/upgrades/unreleased/x.md', 'plugins/a/docs/upgrades')
    ).toBe(true)
  })

  it('accepts either the legacy file or a fragment — the nudge and the gate agree', () => {
    expect(recordsPortingNote(['apps/web/src/x.ts', 'docs/upgrades/unreleased.md'])).toBe(true)
    expect(recordsPortingNote(['apps/web/src/x.ts', 'docs/upgrades/unreleased/x-y.md'])).toBe(true)
    expect(recordsPortingNote(['apps/web/src/x.ts', 'docs/upgrades/unreleased/README.md'])).toBe(
      false
    )
    expect(recordsPortingNote(['apps/web/src/x.ts'])).toBe(false)
  })
})

describe('listItems', () => {
  it('drops any numbering, keeps continuations and treats bare prose as one item', () => {
    expect(listItems('1. one\n   wrapped\n2) two\n- three\n* four')).toEqual([
      { first: 'one', rest: ['wrapped'] },
      { first: 'two', rest: [] },
      { first: 'three', rest: [] },
      { first: 'four', rest: [] },
    ])
    expect(listItems('- a\n\n  ```sh\n  pnpm x\n  ```\n- b')).toEqual([
      { first: 'a', rest: ['', '```sh', 'pnpm x', '```'] },
      { first: 'b', rest: [] },
    ])
    expect(listItems('Nothing to do: kit tooling only.')).toEqual([
      { first: 'Nothing to do: kit tooling only.', rest: [] },
    ])
    expect(listItems('')).toEqual([])
  })
})

describe('mergeNotes', () => {
  const release = { version: '0.2.0', previous: '0.1.0', date: '2026-11-28' }
  const FIRST = fragment({
    front:
      'order: first\nbreaking: false\nmigrations: []\nareas: [docs]\ntouches_surfaces: []\nrequires_surfaces: []\nmanual: true',
    changed: 'Copies below 0.44 upgrade to 0.44.1 first.',
    apply: '- Below 0.44.0, run `pnpm kit:upgrade --to 0.44.1 --apply` first.',
    verify: '- `pnpm gate` passes.',
  })
  const ALPHA = fragment({
    front:
      'breaking: true\nmigrations: ["a column on agent_runs", "an index on documents"]\nareas: [api, db]\ntouches_surfaces: [feature-chat]\nrequires_surfaces: []\nmanual: false',
    changed: 'Alpha summary.\n- Alpha bullet.',
    apply: '- Alpha step.\n  With a continuation.\n- Alpha step two.',
    conflicts: "- `apps/web/src/a.ts` → alpha → take the kit's.",
    verify: '1. Alpha check.\n2. `pnpm gate` passes.',
  })
  const BETA = fragment({
    changed: 'Beta summary.',
    apply: '7. Beta step.',
    conflicts: 'None — beta touches no shared file.',
    verify: '- Beta check.',
  })
  const merged = mergeNotes(
    [
      { name: 'beta.md', text: BETA },
      { name: 'alpha.md', text: ALPHA },
      { name: 'unreleased.md', text: LEGACY, legacy: true },
      { name: 'zz-first.md', text: FIRST },
    ],
    release
  )
  const note = parseNote(merged)
  const section = (h: string) => merged.split(`## ${h}\n\n`)[1]?.split('\n\n## ')[0].trim()

  it('is a well-formed note for the release', () => {
    expect(
      noteProblems(merged, {
        file: '0.2.0.md',
        version: '0.2.0',
        expectPrevious: '0.1.0',
        surfaceIds: ['feature-chat'],
      })
    ).toEqual([])
    expect(merged).not.toMatch(/ \n/)
  })

  it('ORs the booleans and unions the lists without duplicates', () => {
    expect(note?.data).toMatchObject({
      version: '0.2.0',
      previous: '0.1.0',
      date: '2026-11-28',
      breaking: true,
      manual: true,
      migrations: ['a column on agent_runs', 'an index on documents'],
      areas: ['docs', 'api', 'ui', 'db'],
      touches_surfaces: ['feature-chat'],
      requires_surfaces: [],
    })
  })

  it('puts order: first first, then the legacy file, then fragments by filename', () => {
    expect(section('What changed')).toBe(
      [
        'Copies below 0.44 upgrade to 0.44.1 first.',
        'The legacy summary.',
        'Alpha summary.',
        'Beta summary.',
        '',
        '- Legacy bullet one.',
        '- Legacy bullet two.',
        '- Alpha bullet.',
      ].join('\n')
    )
  })

  it('numbers the steps from 1, whatever numbers the parts carried', () => {
    expect(section('How to apply')).toBe(
      [
        '1. Below 0.44.0, run `pnpm kit:upgrade --to 0.44.1 --apply` first.',
        '2. Legacy step one.',
        '3. Legacy step two, which wraps',
        '   onto a second line.',
        '4. Alpha step.',
        '   With a continuation.',
        '5. Alpha step two.',
        '6. Beta step.',
      ].join('\n')
    )
  })

  it('keeps a single trailing gate step, and drops the parts that say no conflict', () => {
    expect(section('Verify')).toBe(
      ['1. Legacy check.', '2. Alpha check.', '3. Beta check.', '4. `pnpm gate` passes.'].join('\n')
    )
    expect(section('Conflicts to expect')).toBe(
      [
        "- `apps/web/src/x.ts` → changed → take the kit's.",
        "- `apps/web/src/a.ts` → alpha → take the kit's.",
      ].join('\n')
    )
  })

  it('says None. when every part does, and adds no gate step nobody asked for', () => {
    const only = mergeNotes([{ name: 'beta.md', text: BETA }], { ...release, previous: null })
    expect(only).toContain('previous: null')
    expect(only).toContain('## Conflicts to expect\n\nNone.\n')
    expect(only).not.toContain('pnpm gate')
  })

  it('refuses a part it cannot fold rather than dropping it', () => {
    expect(() => mergeNotes([{ name: 'x.md', text: 'no frontmatter' }], release)).toThrow(
      /x\.md: no YAML frontmatter/
    )
    expect(() =>
      mergeNotes([{ name: 'x.md', text: `${fragment()}\n## Notes\n\nx\n` }], release)
    ).toThrow(/'## Notes' is not one of the four headings/)
  })
})

/** A throwaway directory, removed after each test. */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rf-fragments-'))
  dirs.push(dir)
  return dir
}
const put = (dir: string, rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  writeFileSync(path.join(dir, rel), text)
}

describe('unreleasedVerdict — the check that requires a note', () => {
  it('accepts a fragment the change adds, as it accepts the legacy file', () => {
    const dir = scratch()
    put(dir, 'docs/upgrades/unreleased/my-change.md', fragment())
    put(dir, 'docs/upgrades/unreleased.md', LEGACY)
    expect(unreleasedVerdict(dir, ['docs/upgrades/unreleased/my-change.md'])).toMatchObject({
      noted: true,
      problems: [],
    })
    expect(unreleasedVerdict(dir, ['docs/upgrades/unreleased.md']).noted).toBe(true)
    expect(unreleasedVerdict(dir, ['apps/web/src/x.ts']).noted).toBe(false)
  })

  it('refuses a malformed fragment by name, and a deleted one records nothing', () => {
    const dir = scratch()
    put(dir, 'docs/upgrades/unreleased/bad.md', fragment({ front: 'version: 0.2.0' }))
    const verdict = unreleasedVerdict(dir, ['docs/upgrades/unreleased/bad.md'])
    expect(verdict.problems.join('\n')).toMatch(/unreleased\/bad\.md: carries 'version'/)
    expect(unreleasedVerdict(dir, ['docs/upgrades/unreleased/gone.md']).noted).toBe(false)
  })

  it('validates against the kit manifest when there is one', () => {
    const dir = scratch()
    put(dir, '.rocketflare.json', JSON.stringify({ app: null, surfaces: [{ id: 'feature-chat' }] }))
    put(
      dir,
      'docs/upgrades/unreleased/s.md',
      fragment({
        front:
          'breaking: false\nmigrations: []\nareas: []\ntouches_surfaces: [nope]\nrequires_surfaces: []\nmanual: false',
      })
    )
    expect(unreleasedVerdict(dir, ['docs/upgrades/unreleased/s.md']).problems[0]).toMatch(
      /touches_surfaces names 'nope', which is not a surface in \.rocketflare\.json/
    )
  })
})

const node = (script: string, args: string[], cwd: string) =>
  spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd,
    encoding: 'utf8',
  })

/** A minimal kit repository at 0.1.0 with `unreleased.md` (entries or not) and fragments. */
function kit({ legacy = LEGACY, fragments = {} as Record<string, string> } = {}) {
  const dir = scratch()
  put(dir, 'package.json', `${JSON.stringify({ name: 'kit', version: '0.1.0' }, null, 2)}\n`)
  put(
    dir,
    '.rocketflare.json',
    `${JSON.stringify(
      {
        app: null,
        kit: { version: '0.1.0' },
        surfaces: [{ id: 'feature-chat' }],
        defaultPlugins: [],
      },
      null,
      2
    )}\n`
  )
  put(
    dir,
    'CHANGELOG.md',
    '# Changelog\n\n## 0.1.0 — 2026-01-01\n\nFirst.\n[Porting note](docs/upgrades/0.1.0.md).\n'
  )
  put(
    dir,
    'docs/upgrades/0.1.0.md',
    fragment().replace(
      '---\nbreaking',
      '---\nversion: 0.1.0\nprevious: null\ndate: 2026-01-01\nbreaking'
    )
  )
  put(dir, 'docs/upgrades/unreleased.md', legacy)
  put(dir, 'docs/upgrades/unreleased/README.md', '# Fragments\n')
  for (const [name, text] of Object.entries(fragments))
    put(dir, `docs/upgrades/unreleased/${name}`, text)
  return dir
}

describe('scripts/release.mjs, end to end', () => {
  const FRAGMENTS = {
    'upgrade-first.md': fragment({
      front:
        'order: first\nbreaking: false\nmigrations: []\nareas: [docs]\ntouches_surfaces: []\nrequires_surfaces: []\nmanual: true',
      changed: 'Copies below 0.44 upgrade to 0.44.1 first.',
      apply: '- Below 0.44.0, upgrade to 0.44.1 first.',
      verify: '- `pnpm gate` passes.',
    }),
    'branding.md': fragment({ changed: 'Branding summary.', apply: '- Branding step.' }),
  }
  const release = (dir: string, ...extra: string[]) =>
    node('release.mjs', ['0.2.0', '--date', '2026-11-28', '--repo-root', dir, ...extra], dir)

  it('a dry run names every part it would fold, and writes nothing', () => {
    const dir = kit({ fragments: FRAGMENTS })
    const r = release(dir, '--dry-run')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/docs\/upgrades\/0\.2\.0\.md\s+from unreleased\.md \+ 2 fragment\(s\)/)
    expect(r.stdout).toMatch(/docs\/upgrades\/unreleased\/branding\.md\s+folded, deleted/)
    expect(r.stdout).toMatch(/docs\/upgrades\/unreleased\/upgrade-first\.md\s+folded, deleted/)
    expect(existsSync(path.join(dir, 'docs/upgrades/0.2.0.md'))).toBe(false)
    expect(listFragments('docs/upgrades', { root: dir })).toHaveLength(2)
  })

  it('folds the legacy file and two fragments into a note the tag gate passes', () => {
    const dir = kit({ fragments: FRAGMENTS })
    const r = release(dir)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/tighten it in both before you commit/)

    const note = readFileSync(path.join(dir, 'docs/upgrades/0.2.0.md'), 'utf8')
    expect(note).toMatch(/^---\nversion: 0\.2\.0\nprevious: 0\.1\.0\ndate: 2026-11-28\n/)
    expect(note).toContain('manual: true')
    expect(note).toContain(
      '## How to apply\n\n1. Below 0.44.0, upgrade to 0.44.1 first.\n2. Legacy step one.'
    )
    expect(note).toContain('4. Branding step.')
    expect(note.match(/`pnpm gate` passes\./g)).toHaveLength(1)

    // The fragments are gone, their README stays, and unreleased.md is the empty template again.
    expect(listFragments('docs/upgrades', { root: dir })).toEqual([])
    expect(existsSync(path.join(dir, 'docs/upgrades/unreleased/README.md'))).toBe(true)
    const fresh = readFileSync(path.join(dir, 'docs/upgrades/unreleased.md'), 'utf8')
    expect(fresh).toMatch(/_Nothing yet\./)
    expect(fresh).toContain('previous: 0.2.0')

    expect(readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toMatch(
      /## 0\.2\.0 — 2026-11-28\n\nCopies below 0\.44 upgrade to 0\.44\.1 first\. The legacy summary\./
    )
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.2.0')
    const gate = node('release-check.mjs', ['--tag', '0.2.0', '--repo-root', dir], dir)
    expect(gate.status, gate.stderr).toBe(0)
  })

  it('releases fragments alone when unreleased.md is empty', () => {
    const empty = LEGACY.replace(
      /## What changed\n\n[\s\S]*$/,
      '## What changed\n\n_Nothing yet._\n'
    )
    const dir = kit({ legacy: empty, fragments: { 'branding.md': FRAGMENTS['branding.md'] } })
    const r = release(dir)
    expect(r.status, r.stderr).toBe(0)
    const note = readFileSync(path.join(dir, 'docs/upgrades/0.2.0.md'), 'utf8')
    expect(note).not.toContain('Legacy')
    expect(note).toContain('## How to apply\n\n1. Branding step.\n')
  })

  it('refuses an invalid fragment, and a release with nothing at all to port', () => {
    const bad = kit({ fragments: { 'bad.md': fragment({ apply: '' }) } })
    const r = release(bad)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/unreleased\/bad\.md: '## How to apply' is empty/)
    expect(existsSync(path.join(bad, 'docs/upgrades/0.2.0.md'))).toBe(false)

    const nothing = kit({ legacy: '---\nversion: unreleased\n---\n\n_Nothing yet._\n' })
    const n = release(nothing)
    expect(n.status).toBe(1)
    expect(n.stderr).toMatch(/has no fragment/)
  })

  it('without a fragment, leaves the legacy file byte for byte the note', () => {
    const dir = kit()
    expect(release(dir).status).toBe(0)
    expect(readFileSync(path.join(dir, 'docs/upgrades/0.2.0.md'), 'utf8')).toBe(
      LEGACY.replace('version: unreleased', 'version: 0.2.0').replace(
        'date: null',
        'date: 2026-11-28'
      )
    )
  })

  it('the tag gate refuses a fragment left behind', () => {
    const dir = kit({ fragments: { 'branding.md': FRAGMENTS['branding.md'] } })
    expect(release(dir).status).toBe(0)
    put(dir, 'docs/upgrades/unreleased/late.md', fragment())
    const gate = node('release-check.mjs', ['--tag', '0.2.0', '--repo-root', dir], dir)
    expect(gate.status).toBe(1)
    expect(gate.stderr).toMatch(/still has 1 fragment\(s\).*late\.md/)
  })
})

describe('release-check --unreleased, end to end', () => {
  function repo() {
    const dir = kit()
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@example.com',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@example.com',
        },
      })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-q', '-m', 'base')
    put(dir, 'apps/web/src/x.ts', 'export const x = 1\n')
    return { dir, git }
  }
  const check = (dir: string) =>
    node('release-check.mjs', ['--unreleased', '--base', 'HEAD~1', '--repo-root', dir], dir)

  it('passes a behaviour change carrying a fragment, fails one without, names a bad one', () => {
    const r = repo()
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'no note')
    const none = check(r.dir)
    expect(none.status).toBe(1)
    expect(none.stderr).toMatch(/add a fragment, docs\/upgrades\/unreleased\/<slug>\.md/)

    r.git('reset', '-q', '--soft', 'HEAD~1')
    put(r.dir, 'docs/upgrades/unreleased/x-change.md', fragment())
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'with a fragment')
    const ok = check(r.dir)
    expect(ok.status, ok.stderr).toBe(0)

    r.git('reset', '-q', '--soft', 'HEAD~1')
    put(r.dir, 'docs/upgrades/unreleased/x-change.md', fragment({ verify: '' }))
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'with a bad fragment')
    const bad = check(r.dir)
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/x-change\.md: '## Verify' is empty/)
  })
})
