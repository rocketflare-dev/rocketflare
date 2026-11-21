/**
 * The `.ts` sources of `apps/web/src`, relative to `apps/web` — tracked files PLUS untracked ones
 * git does not ignore (`git ls-files --cached --others --exclude-standard`), so the .gitignore
 * semantics are git's and a generated or ignored file is never scanned.
 *
 * `--others` matters: with `--cached` alone this read the INDEX, so a new file nobody had
 * `git add`ed yet was invisible. The tenant-query scanner then silently skipped it — a local gate
 * on fresh, unstaged work never checked its queries — and the allow-list test reported a listed
 * file that plainly existed as "not a source file". The case that surfaced it is `kit:upgrade
 * --apply` (which now stages what it writes, too), but any new file before its first `git add` hit
 * it.
 *
 * Filtered by `existsSync`, and that is not belt-and-braces: the index still lists a file deleted
 * on disk and not yet staged. `pnpm plugin remove --apply` deletes three directories, and the gate
 * you are told to run next is `pnpm gate` — before any `git add`. Without this filter every scanner
 * here died with ENOENT on a file the tool had just, correctly, removed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const WEB_ROOT = path.resolve(__dirname, '../..')

/** `root` is `apps/web`; a test passes a fixture repository's. */
export function sourceFiles(root: string = WEB_ROOT): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src'],
    { cwd: root, encoding: 'utf8' }
  )
  return [...new Set(out.split('\n'))]
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter(f => existsSync(path.join(root, f)))
    .sort()
}
