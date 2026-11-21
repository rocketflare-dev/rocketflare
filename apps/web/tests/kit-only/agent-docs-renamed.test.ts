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
 * tree (tracked + untracked, `.gitignore` honoured) into a temp repo, renames it there with
 * `--skip-install`, and runs the check. No network, no database.
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

  it('the docs check passes with no failure', () => {
    const r = spawnSync(process.execPath, ['.claude/skills/rf-agent-docs/check.mjs', '--quiet'], {
      cwd: copy,
      encoding: 'utf8',
    })
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout).not.toMatch(/kit:release|test:kit-only/)
  })
})
