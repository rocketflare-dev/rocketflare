/**
 * The Claude Code nudge hooks (`scripts/changelog-nudge.mjs`, `scripts/release-site-nudge.mjs`)
 * and their pure half, `scripts/lib/nudge-lib.mjs`.
 *
 * The property that matters most is the OUTPUT SHAPE: a `PreToolUse` hook's plain stdout never
 * reaches Claude, so a nudge that prints text is a nudge nobody sees. The end-to-end case runs the
 * real release hook in a throwaway git repository shaped like the kit.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitsAll,
  hookJson,
  isGitCommit,
  siteReminder,
  versionChange,
  versionOf,
} from '../../../../scripts/lib/nudge-lib.mjs'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

describe('nudge-lib', () => {
  it('recognises a commit, and a commit that stages tracked changes itself', () => {
    expect(isGitCommit('git commit -m "x"')).toBe(true)
    expect(isGitCommit('git add -A && git commit -q -F -')).toBe(true)
    expect(isGitCommit('git status')).toBe(false)
    expect(commitsAll('git commit -am "Release 1.0.0"')).toBe(true)
    expect(commitsAll('git commit -a -m x')).toBe(true)
    expect(commitsAll('git commit -m "a -b"')).toBe(false)
  })

  it('reads a version change and ignores anything unreadable', () => {
    const pkg = (version?: string) => JSON.stringify({ name: 'x', version })
    expect(versionOf(pkg('1.2.3'))).toBe('1.2.3')
    expect(versionOf('not json')).toBeNull()
    expect(versionChange(pkg('0.12.0'), pkg('0.13.0'))).toEqual({ from: '0.12.0', to: '0.13.0' })
    expect(versionChange(pkg('0.12.0'), pkg('0.12.0'))).toBeNull()
    // A first commit has no HEAD to compare against, and is still a version to announce.
    expect(versionChange('', pkg('0.1.0'))).toEqual({ from: null, to: '0.1.0' })
    expect(versionChange(pkg('0.12.0'), '')).toBeNull()
  })

  it('tells a plugins release to update the plugins page too', () => {
    const kit = siteReminder({ from: '0.12.0', to: '0.13.0', kind: 'kit' })
    const plugins = siteReminder({ from: '3.2.0', to: '3.3.0', kind: 'plugins' })
    expect(kit).toContain('npm run sync:releases')
    expect(kit).toContain('PLAIN TEXT')
    expect(plugins).toContain('src/data/plugins.ts')
    expect(plugins).toContain('npm run sync:plugins')
    expect(kit).not.toContain('src/data/plugins.ts')
    expect(siteReminder({ from: null, to: '1.0.0', kind: 'kit', wwwDir: '/w' })).toContain('In /w,')
  })

  it('writes the shape Claude reads — additionalContext, never bare text', () => {
    const out = JSON.parse(hookJson('line one\nline two', 'notice'))
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'line one\nline two' },
      systemMessage: 'notice',
    })
    expect(JSON.parse(hookJson('only line')).systemMessage).toBe('only line')
  })
})

describe('release-site-nudge.mjs, end to end', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A throwaway repository with the hook and its lib, committed at `version`. */
  function repo(version: string, manifest: Record<string, unknown> | null) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nudge-'))
    dirs.push(dir)
    mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true })
    copyFileSync(
      path.join(REPO_ROOT, 'scripts/release-site-nudge.mjs'),
      path.join(dir, 'scripts/release-site-nudge.mjs')
    )
    copyFileSync(
      path.join(REPO_ROOT, 'scripts/lib/nudge-lib.mjs'),
      path.join(dir, 'scripts/lib/nudge-lib.mjs')
    )
    if (manifest) writeFileSync(path.join(dir, '.rocketflare.json'), JSON.stringify(manifest))
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }))
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
    git('commit', '-q', '-m', 'init')
    return {
      dir,
      bump(next: string) {
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: next }))
        git('add', 'package.json')
      },
      run(command: string) {
        const r = spawnSync(process.execPath, ['scripts/release-site-nudge.mjs'], {
          cwd: dir,
          encoding: 'utf8',
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        })
        expect(r.status).toBe(0)
        return r.stdout
      },
    }
  }

  it('reminds on a staged version bump in the kit', () => {
    const r = repo('0.12.0', { app: null })
    r.bump('0.13.0')
    const out = JSON.parse(r.run('git commit -m "Release 0.13.0"'))
    expect(out.hookSpecificOutput.additionalContext).toContain('from 0.12.0 to 0.13.0')
    expect(out.systemMessage).toContain('rocketflare-www')
  })

  it('is silent without a bump, for a non-commit, and in an app', () => {
    const kit = repo('0.12.0', { app: null })
    expect(kit.run('git commit -m "no bump"')).toBe('')
    kit.bump('0.13.0')
    expect(kit.run('git status')).toBe('')
    const app = repo('1.0.0', { app: { slug: 'acme' } })
    app.bump('1.1.0')
    expect(app.run('git commit -m "Release 1.1.0"')).toBe('')
  })

  it('fires in a plugins monorepo', () => {
    const r = repo('3.2.0', null)
    mkdirSync(path.join(r.dir, 'plugins/demo'), { recursive: true })
    writeFileSync(path.join(r.dir, 'plugins/demo/rocketflare-plugin.json'), '{"id":"demo"}')
    r.bump('3.3.0')
    const out = JSON.parse(r.run('git commit -m "Release 3.3.0"'))
    expect(out.hookSpecificOutput.additionalContext).toContain('rocketflare-plugins')
    expect(out.hookSpecificOutput.additionalContext).toContain('src/data/plugins.ts')
  })
})
