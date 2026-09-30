/**
 * The gate is ONE command, `pnpm gate` (docs/CONCEPTS.md §4). The four-command string it replaced
 * was copied into eight docs and skills, and a copy of it is how a second definition starts: the
 * next person to add a step edits one copy and not the others. So it may not reappear anywhere
 * tracked — except the porting notes and the changelog, which record history (and this file, which
 * builds the string rather than spelling it).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const OLD_GATE = ['lint', 'typecheck', 'test'].map(s => `pnpm ${s}`).join(' && ')
const HISTORY = /^(docs\/upgrades\/|CHANGELOG\.md$)/

describe('the gate is spelled one way', () => {
  it('no tracked file spells out the old four-command gate', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(f => f && !HISTORY.test(f) && /\.(md|mjs|ts|tsx|yml|json|sh)$/.test(f))
      .filter(f => existsSync(path.join(REPO_ROOT, f)))
    const offenders = files.filter(f =>
      readFileSync(path.join(REPO_ROOT, f), 'utf8').replace(/\s+/g, ' ').includes(OLD_GATE)
    )
    expect(offenders, `use \`pnpm gate\` instead of \`${OLD_GATE} …\``).toEqual([])
  })
})
