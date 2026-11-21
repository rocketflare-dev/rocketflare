/**
 * `release-check.mjs --version-only <parent>`: is HEAD nothing but a root `package.json` `"version"`
 * bump over its one parent? It is what lets deploy.yml's `gated` job accept Launch's
 * `release: X.Y.Z` commit on its PARENT's green CI run (`tests/config/ci-workflows.test.ts`), so
 * every refusal below is a way a real change could otherwise ride a version bump past the gate.
 *
 * `versionOnlyProblems` is pure and asserted directly; `versionOnly` and the CLI are driven once
 * against scratch git repositories, because "which parent, which diff, which bytes" is git's
 * answer and a fake would only restate the implementation. The `config` project: no database.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { versionOnly, versionOnlyProblems } from '../../../../scripts/release-check.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const PARENT = 'b'.repeat(40)
const pkg = (fields: Record<string, unknown>) => `${JSON.stringify(fields, null, 2)}\n`
const BEFORE = pkg({ name: 'app', version: '1.0.0', private: true, scripts: { gate: 'x' } })
const AFTER = pkg({ name: 'app', version: '1.0.1', private: true, scripts: { gate: 'x' } })

const facts = (over: Partial<Parameters<typeof versionOnlyProblems>[0]> = {}) => ({
  parents: [PARENT],
  parentSha: PARENT,
  changed: ['package.json'],
  before: BEFORE,
  after: AFTER,
  ...over,
})

describe('versionOnlyProblems', () => {
  it('passes a bump of the root version and nothing else', () => {
    expect(versionOnlyProblems(facts())).toEqual([])
  })

  it('fails any other key changed in package.json', () => {
    const after = pkg({ name: 'app', version: '1.0.1', private: true, scripts: { gate: 'y' } })
    expect(versionOnlyProblems(facts({ after }))).toEqual([
      'package.json keys other than "version" changed: scripts',
    ])
    const added = pkg({
      name: 'app',
      version: '1.0.1',
      private: true,
      scripts: { gate: 'x' },
      x: 1,
    })
    expect(versionOnlyProblems(facts({ after: added }))[0]).toContain(': x')
  })

  it('fails a nested "version" changed alongside the top-level one', () => {
    const before = pkg({ name: 'app', version: '1.0.0', engines: { version: '1' } })
    const after = pkg({ name: 'app', version: '1.0.1', engines: { version: '2' } })
    expect(versionOnlyProblems(facts({ before, after }))[0]).toContain('engines')
  })

  it('fails a reformat, even when every value other than the version is equal', () => {
    const compact = `${JSON.stringify({ name: 'app', version: '1.0.1', private: true, scripts: { gate: 'x' } })}\n`
    expect(versionOnlyProblems(facts({ after: compact }))[0]).toMatch(/reformatted/)
    // Reordered keys: the same values, different bytes.
    const reordered = pkg({ version: '1.0.1', name: 'app', private: true, scripts: { gate: 'x' } })
    expect(versionOnlyProblems(facts({ after: reordered }))[0]).toMatch(/reformatted/)
    // Whitespace inside the version line itself.
    expect(
      versionOnlyProblems(
        facts({ after: AFTER.replace('"version": "1.0.1"', '"version":"1.0.1"') })
      )[0]
    ).toMatch(/reformatted/)
    // A trailing newline dropped.
    expect(versionOnlyProblems(facts({ after: AFTER.trimEnd() }))[0]).toMatch(/reformatted/)
  })

  it('fails when another file changed, and names it', () => {
    const problems = versionOnlyProblems(facts({ changed: ['package.json', 'apps/web/src/a.ts'] }))
    expect(problems).toEqual(['files other than the root package.json changed: apps/web/src/a.ts'])
    expect(versionOnlyProblems(facts({ changed: ['apps/web/package.json'] }))).toEqual([
      'files other than the root package.json changed: apps/web/package.json',
      'the root package.json did not change',
    ])
  })

  it('fails a commit that changes nothing — an empty commit is not a version bump', () => {
    expect(versionOnlyProblems(facts({ changed: [] }))[0]).toMatch(/nothing changed/)
  })

  it('fails when the version itself did not change', () => {
    // Reachable only through a reformat (the file changed, the values did not).
    const same = BEFORE.replace('\n}', '\n}\n')
    expect(versionOnlyProblems(facts({ after: same }))).toEqual([
      'the version did not change (1.0.0)',
    ])
  })

  it('fails a merge commit, a root commit, and a parent that is not HEAD’s', () => {
    expect(versionOnlyProblems(facts({ parents: [PARENT, 'c'.repeat(40)] }))[0]).toMatch(
      /2 parents/
    )
    expect(versionOnlyProblems(facts({ parents: [] }))[0]).toMatch(/0 parents/)
    expect(versionOnlyProblems(facts({ parentSha: 'c'.repeat(40) }))[0]).toMatch(
      /is not HEAD's parent/
    )
    expect(versionOnlyProblems(facts({ parentSha: null }))[0]).toMatch(/does not resolve/)
  })

  it('fails a package.json missing on either side, or not JSON', () => {
    expect(versionOnlyProblems(facts({ before: null }))[0]).toMatch(/missing in the parent/)
    expect(versionOnlyProblems(facts({ after: null }))[0]).toMatch(/missing at HEAD/)
    expect(versionOnlyProblems(facts({ after: '{' }))[0]).toMatch(/not valid JSON/)
  })
})

describe('versionOnly and --version-only, against git', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false']
  const git = (cwd: string, args: string[]) =>
    execFileSync('git', [...GIT, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const write = (dir: string, rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  const commit = (dir: string, message: string) => {
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', message, '--allow-empty'])
  }

  /** A repository with one commit holding BEFORE and a source file. */
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'version-only-'))
    dirs.push(dir)
    write(dir, 'package.json', BEFORE)
    write(dir, 'src/a.ts', 'export {}\n')
    git(dir, ['init', '-q', '-b', 'main'])
    commit(dir, 'feature')
    return dir
  }

  const cli = (dir: string, parent = 'HEAD^') =>
    spawnSync(
      'node',
      [
        path.join(REPO_ROOT, 'scripts/release-check.mjs'),
        '--version-only',
        parent,
        '--repo-root',
        dir,
      ],
      { cwd: dir, encoding: 'utf8' }
    )

  it('passes a release commit that bumps only the root version', () => {
    const dir = repo()
    write(dir, 'package.json', AFTER)
    commit(dir, 'release: 1.0.1')
    expect(versionOnly(dir, 'HEAD^')).toEqual({
      parent: git(dir, ['rev-parse', 'HEAD^']),
      problems: [],
    })
    const r = cli(dir)
    expect(r.status, r.stderr).toBe(0)
  })

  it('reads the COMMITTED HEAD, not the working tree', () => {
    const dir = repo()
    write(dir, 'package.json', AFTER)
    commit(dir, 'release: 1.0.1')
    write(dir, 'src/a.ts', 'uncommitted\n')
    expect(versionOnly(dir, 'HEAD^').problems).toEqual([])
  })

  it('fails, exit 1, and says what else changed', () => {
    const dir = repo()
    write(dir, 'package.json', AFTER)
    write(dir, 'src/a.ts', 'export const x = 1\n')
    commit(dir, 'release: 1.0.1')
    const r = cli(dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('files other than the root package.json changed: src/a.ts')
  })

  it('fails a commit with no package.json change at all', () => {
    const dir = repo()
    write(dir, 'src/a.ts', 'export const x = 1\n')
    commit(dir, 'code')
    expect(versionOnly(dir, 'HEAD^').problems).toContain('the root package.json did not change')
    const empty = repo()
    commit(empty, 'empty')
    expect(versionOnly(empty, 'HEAD^').problems[0]).toMatch(/nothing changed/)
  })

  it('fails a merge commit, even one whose diff to the first parent is only the version', () => {
    const dir = repo()
    git(dir, ['checkout', '-qb', 'side'])
    write(dir, 'package.json', AFTER)
    commit(dir, 'bump on a branch')
    git(dir, ['checkout', '-q', 'main'])
    write(dir, 'other.txt', 'x\n')
    commit(dir, 'main moves')
    git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'side'])
    expect(versionOnly(dir, 'HEAD^').problems[0]).toMatch(/2 parents/)
    expect(cli(dir).status).toBe(1)
  })

  it('fails a parent that is not HEAD’s, and an unknown ref', () => {
    const dir = repo()
    write(dir, 'package.json', AFTER)
    commit(dir, 'release: 1.0.1')
    write(dir, 'package.json', AFTER.replace('1.0.1', '1.0.2'))
    commit(dir, 'release: 1.0.2')
    expect(versionOnly(dir, 'HEAD~2').problems[0]).toMatch(/is not HEAD's parent/)
    expect(versionOnly(dir, 'no-such-ref').problems[0]).toMatch(/does not resolve/)
  })

  it('needs a commit to compare with (exit 2)', () => {
    const r = spawnSync(
      'node',
      [path.join(REPO_ROOT, 'scripts/release-check.mjs'), '--version-only'],
      {
        encoding: 'utf8',
      }
    )
    expect(r.status).toBe(2)
  })
})
