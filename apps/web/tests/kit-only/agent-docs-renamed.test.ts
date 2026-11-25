/**
 * A freshly renamed copy passes `/rf-agent-docs`'s mechanical check.
 *
 * The rename deletes the kit-only files and every package.json script that runs one
 * (`kit:release`, `test:kit-only`), but kit text that stays true of the kit still names them —
 * root `CLAUDE.md` ("in the kit repository only"), `.claude/rules/testing.md`, the rf-plugin
 * reference. The check failed a brand-new copy on those four lines, before its builder had changed
 * anything. The rename now records the scripts it removed (`kitOnlyScripts` in
 * `.rocketflare.json`) and the check expects them to be missing in a copy.
 *
 * Kit-only: it renames THIS checkout's files, which a copy has already done. Copies the working
 * tree (tracked + untracked, `.gitignore` honoured) into a temp repo, runs the check there once
 * as the kit, renames it with `--skip-install`, and runs it again. No network, no database.
 *
 * The claim is that the RENAME adds no failure, not that the tree has none: an installed plugin's
 * own docs (CI's job with the CI plugins installs them before the gate) can carry a stale
 * reference of their own, and that is the plugin's to fix, failing the kit's check and the copy's
 * alike. So the copy's failures are compared with the same tree's failures before the rename.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../../../..')
let tmp = ''
let copy = ''
let rename: ReturnType<typeof spawnSync>
let before: string[] = []

/** The check's `✖ <file>:<line>  <message>` lines, without the closing summary line. */
function failures(cwd: string): { lines: string[]; output: string } {
  const r = spawnSync(process.execPath, ['.claude/skills/rf-agent-docs/check.mjs', '--quiet'], {
    cwd,
    encoding: 'utf8',
  })
  const output = `${r.stdout}\n${r.stderr}`
  const lines = r.stdout
    .split('\n')
    .filter(l => l.startsWith('✖ ') && !l.startsWith('✖ agent docs:'))
  return { lines, output }
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'agent-docs-renamed-'))
  copy = path.join(tmp, 'copy')
  mkdirSync(copy)
  const listed = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  for (const rel of listed) {
    try {
      cpSync(path.join(REPO, rel), path.join(copy, rel), { verbatimSymlinks: true })
    } catch {
      // Listed by the index but deleted on disk (an unstaged removal): not part of the copy.
    }
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: copy })
  before = failures(copy).lines
  rename = spawnSync(
    process.execPath,
    ['scripts/rename.mjs', '--force', '--skip-install', 'acme-hotel', 'Acme Hotel'],
    { cwd: copy, encoding: 'utf8' }
  )
}, 120_000)

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('a renamed copy and /rf-agent-docs', () => {
  it('the rename records the kit-only scripts it removed', () => {
    expect(rename.status, String(rename.stderr)).toBe(0)
    const manifest = JSON.parse(readFileSync(path.join(copy, '.rocketflare.json'), 'utf8'))
    expect(manifest.app.slug).toBe('acme-hotel')
    expect(manifest.kitOnlyScripts).toEqual(
      expect.arrayContaining(['kit:release', 'test:kit-only'])
    )
  })

  it('the docs check finds no failure the rename introduced', () => {
    const after = failures(copy)
    expect(after.output).not.toMatch(/kit:release|test:kit-only/)
    expect(
      after.lines.filter(l => !before.includes(l)),
      after.output
    ).toEqual([])
  })
})
