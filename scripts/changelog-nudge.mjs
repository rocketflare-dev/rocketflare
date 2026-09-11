#!/usr/bin/env node
/**
 * A Claude Code `PreToolUse` hook: before a `git commit`, notice when a behaviour change is about
 * to be committed without an entry in `docs/upgrades/unreleased.md`.
 *
 * Why bother, given `.github/workflows/ci.yml` checks the same thing: the entry is much easier to
 * write while the change is in your head than a day later from a diff, and the note is the ONLY
 * thing that carries a kit improvement into the copies people are running.
 *
 * Two honest limits. It only fires inside a Claude Code session — a commit typed in a terminal
 * never sees it — and it is advisory: it prints and exits 0. The gate is CI; the hard stop is the
 * tag (`scripts/release-check.mjs`). Change the final `exit 0` to `exit 2` to make it blocking.
 *
 * It exits silently in an app rather than the kit: `.rocketflare.json` with an `app` block means
 * somebody's product, and the kit's release discipline is none of its business.
 *
 * Reads the hook payload as JSON on stdin. Never fails a commit on its own error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOTE = 'docs/upgrades/unreleased.md'
const WATCHED = /^(apps|packages)\//
const EXEMPT = /(^|\/)(tests?|__tests__)\/|\.test\.(ts|tsx)$|\.md$/

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main() {
  const payload = (() => {
    try {
      return JSON.parse(readStdin())
    } catch {
      return {}
    }
  })()
  const command = payload?.tool_input?.command ?? ''
  if (payload.tool_name !== 'Bash' || !/\bgit\s+commit\b/.test(command)) return

  const manifestPath = path.join(REPO_ROOT, '.rocketflare.json')
  if (!existsSync(manifestPath)) return
  if (JSON.parse(readFileSync(manifestPath, 'utf8')).app != null) return
  if (!existsSync(path.join(REPO_ROOT, NOTE))) return

  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  // `git commit -a` stages tracked changes as it runs, so look at those too.
  const all = /\bcommit\b[^|;]*\s-[a-zA-Z]*a/.test(command)
    ? [
        ...staged,
        ...execFileSync('git', ['diff', '--name-only'], { cwd: REPO_ROOT, encoding: 'utf8' })
          .trim()
          .split('\n')
          .filter(Boolean),
      ]
    : staged

  if (all.includes(NOTE)) return
  const behaviour = all.filter(f => WATCHED.test(f) && !EXEMPT.test(f))
  if (behaviour.length === 0) return

  process.stdout.write(
    `This commit changes ${behaviour.length} file(s) under apps/ or packages/ with no entry in ${NOTE}.\n` +
      'Every copy of the kit absorbs this change by reading that note; without one the change is\n' +
      'invisible to all of them. Add an entry (docs/upgrades/README.md has the shape), or say why\n' +
      'this one needs none.\n' +
      `First few: ${behaviour.slice(0, 5).join(', ')}\n`
  )
}

try {
  main()
} catch {
  // A hook must never be the reason a commit fails.
}
process.exit(0)
