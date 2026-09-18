/**
 * `scripts/upgrade.mjs`'s pure half: path classification against `.rocketflare.json` and the diff
 * translator. The `config` project — no database, no git, no network.
 *
 * The translator is the risky part. It rewrites a kit diff into an adopted app's names before
 * anything is applied, and it is only safe because of two properties asserted below: a
 * substitution moves columns and never lines (so `@@` headers stay valid), and `index` lines are
 * stripped (so `git apply --3way` cannot silently merge against a preimage that no longer
 * describes anything).
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import rawManifest from '../../../../.rocketflare.json'
import { deriveNames } from '../../../../scripts/lib/rename-lib.mjs'
import type { Manifest } from '../../../../scripts/lib/upgrade-lib.d.mts'
import {
  absentSurfaces,
  BinaryPatchError,
  classifyPath,
  countLines,
  defaultPluginEntries,
  defaultPluginProblems,
  globToRegExp,
  isDeployable,
  isKitManifest,
  isVendored,
  matchesAny,
  parseNote,
  satisfies,
  satisfiesResult,
  splitDiff,
  stripIndexLines,
  translateBlock,
} from '../../../../scripts/lib/upgrade-lib.mjs'

// A JSON import widens every literal to `string`; the manifest's shape is the lib's contract.
const manifest = rawManifest as unknown as Manifest

const names = deriveNames('acme', 'Acme Logistics', { domain: 'acme.io' })

describe('globs', () => {
  it('* stops at a slash, ** does not', () => {
    expect(globToRegExp('apps/*/src').test('apps/web/src')).toBe(true)
    expect(globToRegExp('apps/*/src').test('apps/web/deep/src')).toBe(false)
    expect(globToRegExp('apps/**').test('apps/web/deep/src/x.ts')).toBe(true)
    expect(globToRegExp('apps/web/src/**').test('apps/web/src/x.ts')).toBe(true)
  })

  it('matchesAny is an or over globs', () => {
    expect(matchesAny('LICENSE', ['LICENSE', 'README.md'])).toBe(true)
    expect(matchesAny('CHANGELOG.md', ['LICENSE', 'README.md'])).toBe(false)
  })
})

describe('the manifest predicate', () => {
  it('says the kit is the kit and a copy is not', () => {
    // The predicate, both ways, on values rather than on whichever checkout is running this —
    // `app === null` IS the question, so a renamed copy answers `false` and is RIGHT to. Asserting
    // `isKitManifest(manifest) === true` against the repo's own file made every adopted copy's
    // `pnpm test` red on its first run, which is the opposite of what D27 promises.
    expect(isKitManifest({ ...manifest, app: null })).toBe(true)
    expect(
      isKitManifest({ ...manifest, app: { slug: 'acme', display: 'Acme', domain: 'acme.io' } })
    ).toBe(false)
    // …and this checkout agrees with itself, whichever of the two it is.
    expect(isKitManifest(manifest)).toBe(manifest.app === null)
  })

  it('finds the surfaces whose anchor is gone', () => {
    const withoutAgent = ['README.md']
    expect(absentSurfaces(manifest, withoutAgent)).toContain('example-agent-summarize-text')
    expect(absentSurfaces(manifest, withoutAgent).length).toBe(manifest.surfaces.length)
  })
})

describe('classifyPath', () => {
  const base = { manifest, existsLocally: true, change: 'modified' as const }

  it('drops anything under a surface this app deleted — the rule that matters most', () => {
    const c = classifyPath('apps/web/src/api/services/agents/examples/summarize-text.ts', {
      ...base,
      absent: ['example-agent-summarize-text'],
    })
    expect(c.class).toBe('skipped-surface-absent')
    expect(c.surface).toBe('example-agent-summarize-text')
    expect(c.translate).toBe(false)
  })

  it('never touches a file an installed plugin owns, even though the kit shipped it', () => {
    // D31: a plugin has its own repository and its own release chain. A kit diff that rewrote its
    // files would be porting one version of a plugin over another, with neither side told.
    const withPlugin = {
      ...manifest,
      surfaces: [
        ...manifest.surfaces,
        {
          id: 'approvals',
          kind: 'plugin' as const,
          label: 'Approvals',
          anchor: 'apps/web/src/plugins/approvals/plugin.json',
          paths: ['apps/web/src/plugins/approvals/**'],
          registries: ['apps/web/src/plugins/server.ts'],
        },
      ],
    }
    const c = classifyPath('apps/web/src/plugins/approvals/api/routes.ts', {
      ...base,
      manifest: withPlugin,
    })
    expect(c.class).toBe('skipped-plugin-owned')
    expect(c.surface).toBe('approvals')
    expect(c.translate).toBe(false)
    expect(c.reason).toMatch(/pnpm plugin upgrade approvals/)
  })

  it('still drops a plugin whose anchor is gone as absent, not as plugin-owned', () => {
    // Order matters: "the adopter removed it" is the stronger statement, and an uninstalled
    // plugin's leftovers must not be recreated by an upgrade any more than a deleted example is.
    const withPlugin = {
      ...manifest,
      surfaces: [
        ...manifest.surfaces,
        {
          id: 'approvals',
          kind: 'plugin' as const,
          label: 'Approvals',
          anchor: 'apps/web/src/plugins/approvals/plugin.json',
          paths: ['apps/web/src/plugins/approvals/**'],
          registries: [],
        },
      ],
    }
    const c = classifyPath('apps/web/src/plugins/approvals/api/routes.ts', {
      ...base,
      manifest: withPlugin,
      absent: ['approvals'],
    })
    expect(c.class).toBe('skipped-surface-absent')
  })

  it('never applies a kit migration', () => {
    const c = classifyPath('apps/web/migrations/0007_add_thing.sql', base)
    expect(c.class).toBe('migration-derived')
    expect(classifyPath('apps/web/migrations/meta/_journal.json', base).class).toBe(
      'migration-derived'
    )
    expect(c.reason).toMatch(/db:generate/)
  })

  it('sends the wrangler tomls and the env examples to a human', () => {
    expect(classifyPath('apps/web/wrangler.toml', base).class).toBe('manual-toml')
    expect(classifyPath('apps/web/wrangler.staging.toml', base).class).toBe('manual-toml')
    expect(classifyPath('apps/web/.dev.vars.example', base).class).toBe('manual-env')
  })

  it('keeps kit-only files out of an app', () => {
    for (const p of [
      'LICENSE',
      'SECURITY.md',
      'scripts/install.sh',
      'docs/ADAPTING.md',
      'pnpm-lock.yaml',
    ]) {
      expect(classifyPath(p, base).class, p).toBe('skipped-kit-only')
    }
  })

  it('ports the kit tooling untranslated when asked', () => {
    const c = classifyPath('scripts/rename.mjs', { ...base, includeKitTooling: true })
    expect(c.class).toBe('verbatim')
    expect(c.translate).toBe(false)
  })

  it('treats the README and CI as decisions, not edits', () => {
    expect(classifyPath('README.md', base).class).toBe('manual')
    expect(classifyPath('.github/workflows/deploy.yml', base).class).toBe('manual')
  })

  it('reads a file the adopter deleted as skipped, not as an error', () => {
    const c = classifyPath('apps/web/src/api/routes/members.ts', { ...base, existsLocally: false })
    expect(c.class).toBe('skipped-locally-deleted')
  })

  it('separates a clean add from one that collides', () => {
    expect(
      classifyPath('apps/web/src/api/routes/new.ts', {
        ...base,
        change: 'added',
        existsLocally: false,
      }).class
    ).toBe('added')
    expect(
      classifyPath('apps/web/src/api/routes/new.ts', {
        ...base,
        change: 'added',
        existsLocally: true,
      }).class
    ).toBe('added-collides')
  })

  it('never deletes on its own', () => {
    expect(
      classifyPath('apps/web/src/api/routes/old.ts', { ...base, change: 'deleted' }).class
    ).toBe('deleted')
  })

  it('classifies an ordinary source change as modified and translated', () => {
    const c = classifyPath('apps/web/src/api/index.ts', base)
    expect(c.class).toBe('modified')
    expect(c.translate).toBe(true)
  })
})

const PATCH = `diff --git a/apps/web/src/api/index.ts b/apps/web/src/api/index.ts
index 1234abc..5678def 100644
--- a/apps/web/src/api/index.ts
+++ b/apps/web/src/api/index.ts
@@ -1,4 +1,4 @@ export function createApp(rocketflare: string) {
 import { thing } from '@rocketflare/shared/errors'
-const name = 'rocketflare-web'
+const name = 'rocketflare-worker'
 export const ROCKETFLARE_KEY = 'rocketflare_'
diff --git a/LICENSE b/LICENSE
index aaa..bbb 100644
--- a/LICENSE
+++ b/LICENSE
@@ -1,2 +1,2 @@
-Copyright Rocketflare
+Copyright Rocketflare Ltd
`

describe('satisfies', () => {
  // `requires.kit` in a plugin's manifest (D31) is the only consumer, and the kit ships no semver
  // dependency to evaluate it with. A table, because the zero-major caret rule is the one people
  // get wrong and a wrong answer here installs a plugin the gate then rejects.
  it.each([
    ['0.5.0', '>=0.5.0 <1.0.0', true],
    ['0.9.9', '>=0.5.0 <1.0.0', true],
    ['0.4.0', '>=0.5.0 <1.0.0', false],
    ['1.0.0', '>=0.5.0 <1.0.0', false],
    ['1.0.0', '>0.5.0', true],
    ['0.5.0', '<=0.5.0', true],
    ['0.5.1', '<=0.5.0', false],
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '=1.2.3', true],
    ['1.2.4', '1.2.3', false],
    // `^` with a non-zero major is the next major; with a zero major it is the next MINOR, because
    // a 0.x minor bump may break anything. `~` is the next minor either way.
    ['1.9.9', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.5.9', '^0.5.0', true],
    ['0.6.0', '^0.5.0', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.5.9', '~0.5.0', true],
    ['0.6.0', '~0.5.0', false],
    ['1.5.9', '~1.5.0', true],
    ['1.6.0', '~1.5.0', false],
    // No bound at all, and a range with surrounding whitespace.
    ['9.9.9', '*', true],
    ['9.9.9', '', true],
    ['0.6.0', '  >=0.5.0   <1.0.0  ', true],
    // A space after the operator, and `||` alternation: both are ordinary semver spellings a
    // person reaches for without thinking, and both were refused as unreadable until now.
    ['0.6.0', '>= 0.5.0', true],
    ['0.4.0', '>= 0.5.0', false],
    ['0.6.0', '>= 0.5.0 < 1.0.0', true],
    ['0.6.5', '^0.6.0 || ^0.7.0', true],
    ['0.7.1', '^0.6.0 || ^0.7.0', true],
    ['0.8.0', '^0.6.0 || ^0.7.0', false],
    ['1.2.3', '>=2.0.0 || <1.0.0', false],
  ])('%s vs %s → %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  it('is false for a version that is not X.Y.Z, and true for a missing range', () => {
    expect(satisfies('1.2', '>=1.0.0')).toBe(false)
    expect(satisfies('1.2.3-beta.1', '>=1.0.0')).toBe(false)
    expect(satisfies('1.2.3', null)).toBe(true)
    expect(satisfies('1.2.3', undefined)).toBe(true)
  })

  it('REPORTS a range it does not implement rather than throwing or guessing', () => {
    // It used to throw, and the throw arrived as a generic exit 1 from `pnpm plugin add` — where
    // the documented answer for an unmet requirement is exit 6. A silent "true" would install an
    // incompatible plugin, so the structured `problem` is what every caller folds into its list.
    for (const range of ['1.x', 'latest', '>=1.0.0 - 2.0.0']) {
      const answer = satisfiesResult('1.2.3', range)
      expect(answer.ok, range).toBe(false)
      expect(answer.problem, range).toMatch(/unsupported version range/)
    }
    expect(satisfiesResult('1.2.3', '^1.0.0 || ').problem).toMatch(/empty alternative/)
    // A real yes/no carries no problem — that is how a caller tells "no" from "I cannot tell".
    expect(satisfiesResult('1.2.3', '>=2.0.0')).toEqual({ ok: false, problem: null })
    expect(satisfiesResult('1.2.3', '>=1.0.0')).toEqual({ ok: true, problem: null })
    // A version that is not X.Y.Z is a plain no, not an unreadable range.
    expect(satisfiesResult('1.2', '>=1.0.0')).toEqual({ ok: false, problem: null })
  })
})

describe('isVendored', () => {
  // ONE implementation, in this file, re-exported by plugin-lib. The two that existed disagreed:
  // this one normalises the URL, the other compared strings exactly — so the same plugin could be
  // vendored for `kit:release` and third-party for `plugin check`, over one manifest.
  const KIT_REPO = 'https://github.com/rocketflare-dev/rocketflare.git'

  it('is the same answer from either module', async () => {
    const { isVendored: fromPluginLib } = await import('../../../../scripts/lib/plugin-lib.mjs')
    expect(fromPluginLib).toBe(isVendored)
  })

  it('normalises a trailing slash and a missing .git, and refuses a subdirectory', () => {
    expect(isVendored({ repo: KIT_REPO, subdir: '' }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: 'https://github.com/rocketflare-dev/rocketflare' }, KIT_REPO)).toBe(
      true
    )
    expect(isVendored({ repo: `${KIT_REPO}/` }, KIT_REPO)).toBe(true)
    expect(isVendored({ repo: KIT_REPO, subdir: 'plugins/x' }, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: 'https://github.com/acme/p.git' }, KIT_REPO)).toBe(false)
    expect(isVendored(null, KIT_REPO)).toBe(false)
    expect(isVendored({ repo: '' }, KIT_REPO)).toBe(false)
  })
})

describe('default plugins', () => {
  // `defaultPlugins` is what a fresh clone installs and what `kit:release` refuses to ship past
  // (D31, decision 5). The entries are OBJECTS because a bare id says nothing about where the
  // plugin comes from; a string still parses, and is then reported as having no repo rather than
  // having a URL guessed for it.
  const KIT = 'https://github.com/rocketflare-dev/rocketflare.git'
  const ok = (requiresKit: string | null) => () => ({ ok: true, requiresKit })

  it('normalises both shapes and defaults the optional fields', () => {
    expect(
      defaultPluginEntries({
        defaultPlugins: [{ id: 'analytics', repo: KIT, ref: '0.6.0' }, 'legacy'],
      } as never)
    ).toEqual([
      { id: 'analytics', repo: KIT, ref: '0.6.0', subdir: '' },
      { id: 'legacy', repo: null, ref: null, subdir: '' },
    ])
    expect(defaultPluginEntries(null)).toEqual([])
    expect(defaultPluginEntries({} as never)).toEqual([])
  })

  it('passes a plugin whose range admits the version being cut', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git', ref: '0.2.0' }],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok('>=0.5.0 <1.0.0'))).toEqual([])
  })

  it("refuses a version outside a plugin's declared range, naming both", () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git' }],
    } as never)
    const problems = defaultPluginProblems(entries, '1.0.0', ok('>=0.5.0 <1.0.0'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/analytics.*>=0\.5\.0 <1\.0\.0.*1\.0\.0 does not satisfy/)
  })

  it('refuses an entry the resolver cannot reach, and one with no repo', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [
        { id: 'gone', repo: 'https://example.test/gone.git', ref: '9.9.9' },
        'nameless',
      ],
    } as never)
    const problems = defaultPluginProblems(entries, '0.6.0', entry =>
      entry.id === 'gone' ? { ok: false, reason: 'no such ref' } : { ok: true, requiresKit: '*' }
    )
    expect(problems).toEqual([
      expect.stringContaining('no such ref'),
      expect.stringContaining('has no "repo"'),
    ])
  })

  it('reports an unreadable range rather than assuming it is fine', () => {
    // "I could not check" and "I checked and it is fine" are different answers, and only one of
    // them may cut a release.
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'analytics', repo: 'https://example.test/a.git' }],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok(null))[0]).toMatch(
      /cannot read its requires.kit/
    )
    expect(defaultPluginProblems(entries, '0.6.0', ok('1.x'))[0]).toMatch(
      /not a range this kit can read/
    )
  })

  it('exempts a VENDORED plugin from the range check, as §16 says', () => {
    // Same repository, no subdirectory: the same release cut both, so the range describes the kit
    // it shipped inside rather than a compatibility claim.
    const entries = defaultPluginEntries({
      defaultPlugins: [{ id: 'example-feature', repo: KIT, ref: '0.4.0' }],
    } as never)
    expect(defaultPluginProblems(entries, '9.9.9', ok('>=0.5.0 <1.0.0'), { kitRepo: KIT })).toEqual(
      []
    )
    // …but a plugin in a SUBDIRECTORY of the kit repo is not vendored, and is checked.
    const sub = [{ id: 'x', repo: KIT, ref: null, subdir: 'plugins/x' }]
    expect(
      defaultPluginProblems(sub, '9.9.9', ok('>=0.5.0 <1.0.0'), { kitRepo: KIT })
    ).toHaveLength(1)
  })

  it('catches the same plugin listed twice', () => {
    const entries = defaultPluginEntries({
      defaultPlugins: [
        { id: 'a', repo: 'https://example.test/a.git' },
        { id: 'a', repo: 'https://example.test/a.git' },
      ],
    } as never)
    expect(defaultPluginProblems(entries, '0.6.0', ok('*'))).toEqual([
      expect.stringContaining("lists 'a' twice"),
    ])
  })
})

describe('isDeployable', () => {
  // This gates the deploy workflow, so the expensive mistake is a false "skip": somebody's
  // production release quietly not happening. Every ambiguous case must deploy.
  const KIT = { app: null } as unknown as Manifest
  const APP = { app: { slug: 'acme', display: 'Acme', domain: 'acme.io' } } as unknown as Manifest
  const placeholder = { 'apps/web/wrangler.toml': 'id = "<KV_NAMESPACE_ID>"' }
  const provisioned = { 'apps/web/wrangler.toml': 'id = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"' }

  it('skips only the kit that has never been provisioned', () => {
    const d = isDeployable(KIT, placeholder)
    expect(d.deployable).toBe(false)
    expect(d.reason).toContain('apps/web/wrangler.toml')
  })

  it('deploys an app even when its tomls still hold placeholders', () => {
    // Their parity check fails loudly a step later; that is the gate, and it is meant to be seen.
    expect(isDeployable(APP, placeholder).deployable).toBe(true)
  })

  it('deploys a kit-shaped repo that someone pointed at real resources', () => {
    expect(isDeployable(KIT, provisioned).deployable).toBe(true)
  })

  it('deploys when there is no manifest at all', () => {
    expect(isDeployable(null, placeholder).deployable).toBe(true)
  })

  it('names both tomls when both are unprovisioned', () => {
    const d = isDeployable(KIT, {
      'apps/web/wrangler.toml': '<A_ID>',
      'apps/web/wrangler.staging.toml': '<B_ID>',
    })
    expect(d.reason).toContain('apps/web/wrangler.toml and apps/web/wrangler.staging.toml')
  })
})

describe('splitDiff', () => {
  it('splits on the file header and keeps each block whole', () => {
    const blocks = splitDiff(PATCH)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].header).toContain('apps/web/src/api/index.ts')
    expect(blocks[1].header).toContain('LICENSE')
    expect(blocks[0].raw).toContain('@@ -1,4 +1,4 @@')
  })

  it('is empty for an empty diff', () => {
    expect(splitDiff('')).toEqual([])
  })
})

describe('translateBlock', () => {
  const [source, license] = splitDiff(PATCH)

  it('rewrites the body into the app’s names', () => {
    const t = translateBlock(source, names)
    expect(t).toContain("from '@acme/shared/errors'")
    expect(t).toContain("-const name = 'acme-web'")
    expect(t).toContain("+const name = 'acme-worker'")
    expect(t).toContain('ACME_KEY')
    expect(t).toContain("'acme_'")
    expect(t).not.toContain('rocketflare')
  })

  it('leaves the hunk header counts byte-identical', () => {
    const t = translateBlock(source, names)
    expect(t).toContain('@@ -1,4 +1,4 @@')
    // Against the STRIPPED original: dropping `index` lines is the only length change allowed.
    expect(countLines(stripIndexLines(source.raw))).toBe(countLines(t))
  })

  it('strips the index lines so --3way cannot silently misbehave', () => {
    expect(source.raw).toMatch(/^index /m)
    expect(translateBlock(source, names)).not.toMatch(/^index /m)
  })

  it('translates the path lines even when the body is left alone', () => {
    const t = translateBlock(license, names, { translate: false })
    expect(t).toContain('-Copyright Rocketflare')
    expect(t).toContain('+Copyright Rocketflare Ltd')
    expect(countLines(stripIndexLines(license.raw))).toBe(countLines(t))
  })

  it('refuses a binary block rather than corrupting base85', () => {
    const binary = splitDiff(
      `diff --git a/logo.png b/logo.png
index a..b 100644
GIT binary patch
literal 12
zcmZQ
`
    )[0]
    expect(() => translateBlock(binary, names)).toThrow(BinaryPatchError)
  })
})

describe('parseNote', () => {
  it('reads scalars, booleans, lists and a literal null', () => {
    const note = parseNote(`---
version: 0.5.0
previous: null
breaking: true
migrations: ["a budget column"]
areas: [api, ui]
---

## What changed
body
`)
    expect(note?.data).toMatchObject({
      version: '0.5.0',
      previous: null,
      breaking: true,
      migrations: ['a budget column'],
      areas: ['api', 'ui'],
    })
    expect(note?.body).toContain('## What changed')
  })

  it('reads a block sequence, which is how three long migrations are written', () => {
    const note = parseNote(`---
version: 0.6.0
migrations:
  - "conversations gains a rolling summary"
  - "messages gains nullable provider and model columns"
areas: [api]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'conversations gains a rolling summary',
      'messages gains nullable provider and model columns',
    ])
    expect(note?.data.areas).toEqual(['api'])
  })

  it('keeps a comma inside a quoted item instead of splitting on it', () => {
    // A migrations entry is a human sentence, and sentences contain commas. Splitting on every
    // one turns a description into fragments — a corrupted note rather than a rejected one.
    const note = parseNote(`---
migrations: ["group types, groups and membership, and a visibility column", "a second one"]
---

## What changed
`)
    expect(note?.data.migrations).toEqual([
      'group types, groups and membership, and a visibility column',
      'a second one',
    ])
  })

  it('reads an empty key as null, not as an empty list', () => {
    const note = parseNote(`---
previous:
areas: [api]
---

## What changed
`)
    expect(note?.data.previous).toBeNull()
  })

  it('is null without frontmatter', () => {
    expect(parseNote('# just a heading\n')).toBeNull()
  })
})

/**
 * `mirror().isAncestor` — the predicate behind `kit:upgrade`'s "this diff runs BACKWARDS" warning.
 *
 * The failure it guards against is not a crash: with an untagged branch head as `--from`,
 * `latestTag()` picks an OLDER release as `--to` and the report says "the kit deleted 22 file(s)",
 * listing whole subsystems. Exercised against this repository's own history, which always has at
 * least two commits.
 */
describe('mirror().isAncestor', () => {
  it('knows which way round two commits are', async () => {
    const { mirror } = await import('../../../../scripts/lib/git-lib.mjs')
    const repo = mirror(path.resolve(__dirname, '../../../..'))
    expect(repo.isAncestor('HEAD~1', 'HEAD')).toBe(true)
    expect(repo.isAncestor('HEAD', 'HEAD~1')).toBe(false)
    // A commit is its own ancestor, which is why `upgrade.mjs` answers "already on it" first.
    expect(repo.isAncestor('HEAD', 'HEAD')).toBe(true)
  })
})
