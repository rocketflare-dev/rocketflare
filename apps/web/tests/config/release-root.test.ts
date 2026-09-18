/**
 * WHICH repository a release is cut in — the decision `scripts/release-check.mjs` and
 * `scripts/release.mjs` both open with.
 *
 * It used to be a constant, `path.resolve(dirname(import.meta.url), '..')`, so the root was
 * wherever the SCRIPT lived. A shim that cloned the kit and ran `node .kit/scripts/release.mjs`
 * would therefore stamp the KIT's `package.json` rather than its own, which is why the first-party
 * plugins repository carries a verbatim copy of both scripts and six `scripts/lib/*.mjs` files —
 * thousands of lines of duplicate, already drifting, because one path was computed instead of
 * asked for.
 *
 * The three steps below are that fix, and they are asserted as a pure function rather than through
 * a spawned process: `toplevel` is injected, so none of this touches git or the filesystem.
 * The `config` project: no database.
 */
import { describe, expect, it } from 'vitest'
import { resolveRepoRoot } from '../../../../scripts/release-check.mjs'

const SCRIPT_ROOT = '/opt/kit'
const CWD = '/work/rocketflare-plugins'
const TOPLEVEL = '/work/rocketflare-plugins'

const never = (): string | null => {
  throw new Error('git must not be consulted once --repo-root has answered')
}

/** The resolution with everything injected — no git, no filesystem, no process. */
const resolve = (argv: string[], toplevel: (cwd: string) => string | null = () => TOPLEVEL) =>
  resolveRepoRoot(argv, { cwd: CWD, scriptRoot: SCRIPT_ROOT, toplevel })

describe('resolveRepoRoot', () => {
  it('1. an explicit --repo-root wins, and git is not consulted at all', () => {
    expect(resolve(['0.8.0', '--repo-root', '/srv/other'], never)).toEqual({
      root: '/srv/other',
      rest: ['0.8.0'],
      error: null,
    })
  })

  it('a relative --repo-root resolves against the working directory, not the script', () => {
    expect(resolve(['--repo-root', 'plugins/analytics'], never).root).toBe(
      `${CWD}/plugins/analytics`
    )
    expect(resolve(['--repo-root', '.'], never).root).toBe(CWD)
  })

  it('2. otherwise the git toplevel of the working directory', () => {
    // This is what makes the kit's own scripts mean the checkout you are standing in — both a
    // shim running them from another repository, and `cd apps/web && node ../../scripts/…`.
    const asked: string[] = []
    const resolved = resolve([], cwd => {
      asked.push(cwd)
      return TOPLEVEL
    })
    expect(resolved).toEqual({ root: TOPLEVEL, rest: [], error: null })
    expect(asked).toEqual([CWD])
  })

  it('3. and only then the directory the script itself lives in', () => {
    // Not a checkout, or no git on the machine. The original derivation, so the kit running its
    // own scripts in place is unchanged.
    expect(resolve(['--dry-run'], () => null)).toEqual({
      root: SCRIPT_ROOT,
      rest: ['--dry-run'],
      error: null,
    })
  })

  it('the kit in place answers the same at step 2 and step 3, which is why nothing moved', () => {
    expect(resolve([], () => SCRIPT_ROOT).root).toBe(resolve([], () => null).root)
  })

  it('consumes the flag and leaves every other argument in order', () => {
    // Both scripts parse what is left: one would read the path as a version, the other would
    // reject it as an unknown option, so the flag has to be gone before either loop sees it.
    expect(
      resolve(['0.8.0', '--repo-root', '/srv/other', '--plugin', 'plugins/analytics', '--dry-run'])
        .rest
    ).toEqual(['0.8.0', '--plugin', 'plugins/analytics', '--dry-run'])
  })

  it('is a usage error with no path, including when the next token is another flag', () => {
    for (const argv of [['--repo-root'], ['--repo-root', '--dry-run']]) {
      const resolved = resolve(argv, never)
      expect(resolved.error).toMatch(/--repo-root needs a path/)
      // Still a usable root, so the caller reports the usage error rather than crashing on it.
      expect(resolved.root).toBe(SCRIPT_ROOT)
    }
  })

  it('takes the last --repo-root when it is given twice', () => {
    expect(resolve(['--repo-root', '/a', '--repo-root', '/b'], never).root).toBe('/b')
  })
})
