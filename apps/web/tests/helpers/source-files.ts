/**
 * The tracked `.ts` sources of `apps/web/src`, relative to `apps/web` — `git ls-files`, so the
 * .gitignore semantics are git's and a generated or untracked file is never scanned.
 *
 * Filtered by `existsSync`, and that is not belt-and-braces: `git ls-files` reads the INDEX, so a
 * file deleted on disk and not yet staged is still listed. `pnpm plugin remove --apply` deletes
 * three directories, and the gate you are told to run next is `lint && typecheck && test && build`
 * — before any `git add`. Without this filter every scanner here died with ENOENT on a file the
 * tool had just, correctly, removed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const WEB_ROOT = path.resolve(__dirname, '../..')

export function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'src'], { cwd: WEB_ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter(f => existsSync(path.join(WEB_ROOT, f)))
    .sort()
}
