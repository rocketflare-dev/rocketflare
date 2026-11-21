/**
 * `sourceFiles()` (`tests/helpers/source-files.ts`) — the list every source scanner reads, the
 * tenant-query scanner among them. A new file nobody has `git add`ed yet must be in it (it was
 * silently skipped), an ignored one must not, and a file deleted on disk but still in the index
 * must not either. Real git, a fixture repository in the OS temp directory.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sourceFiles } from '../helpers/source-files'

const root = mkdtempSync(path.join(tmpdir(), 'source-files-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root }
  )
const write = (rel: string, text = 'export {}\n') => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), text)
}

describe('sourceFiles', () => {
  it('lists tracked and new unstaged sources, never ignored or deleted ones', () => {
    git('init', '-q')
    write('.gitignore', 'src/generated.ts\n')
    write('src/tracked.ts')
    write('src/gone.ts')
    git('add', '-A')
    git('commit', '-q', '-m', 'start')
    write('src/api/new-route.ts')
    write('src/ui/New.tsx')
    write('src/generated.ts')
    rmSync(path.join(root, 'src/gone.ts'))
    expect(sourceFiles(root)).toEqual(['src/api/new-route.ts', 'src/tracked.ts', 'src/ui/New.tsx'])
  })
})
