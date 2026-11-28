/**
 * `/rf-agent-docs`'s link check (`.claude/skills/rf-agent-docs/check.mjs`) and the links a doc
 * writes as a TEMPLATE: `[label](url)` in a format description, `[x](<path>)` in a code span, a
 * fenced example of a doc's markdown. Those name no file and must not fail the check; a real
 * relative link that leads nowhere still does. Run against a throwaway git repository holding
 * only a `CLAUDE.md` and the checker.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../../../..')
const CHECK = '.claude/skills/rf-agent-docs/check.mjs'
const sandboxes: string[] = []
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function check(claudeMd: string): string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'rf-agent-docs-links-'))
  sandboxes.push(root)
  mkdirSync(path.join(root, path.dirname(CHECK)), { recursive: true })
  cpSync(path.join(REPO, CHECK), path.join(root, CHECK))
  writeFileSync(path.join(root, 'CLAUDE.md'), claudeMd)
  writeFileSync(path.join(root, 'real.md'), '# real\n')
  execFileSync('git', ['init', '-q'], { cwd: root })
  const r = spawnSync(process.execPath, [CHECK, '--quiet'], { cwd: root, encoding: 'utf8' })
  return `${r.stdout}`.split('\n').filter(l => l.includes('link `'))
}

describe('rf-agent-docs link check', () => {
  it('ignores placeholder targets, links in code spans and links in fenced examples', () => {
    const doc = [
      '# Project',
      '',
      'A finding is written as [title](url), or [x](<path>), or [x](…), or [x](...).',
      'In a code span: `[guide](docs/no-such-guide.md)` is the shape.',
      '',
      '```md',
      'See [the runbook](docs/RUNBOOK.md) for the steps.',
      '```',
      '',
      'And a real one: [real](real.md).',
      '',
    ].join('\n')
    expect(check(doc)).toEqual([])
  })

  it('still fails a real relative link that does not resolve', () => {
    const failures = check('# Project\n\nSee [gone](docs/gone.md).\n')
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('link `docs/gone.md` does not resolve')
  })
})
