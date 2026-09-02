/**
 * The tracked `.ts` sources of `apps/web/src`, relative to `apps/web` — `git ls-files`, so the
 * .gitignore semantics are git's and a generated or untracked file is never scanned.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export const WEB_ROOT = path.resolve(__dirname, '../..')

export function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'src'], { cwd: WEB_ROOT, encoding: 'utf8' })
  return out
    .split('\n')
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .sort()
}
