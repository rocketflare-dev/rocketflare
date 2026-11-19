/**
 * `audit.mjs public-report`: a publishable report from a hand-curated entries file. A public
 * report carries counts only: the runs, and how many issues of each severity were fixed in each
 * release. No field may describe an individual issue, and the whole file is refused, writing
 * nothing, on anything else: an unknown or free-text field, a count with no fixing release, a
 * count that is not a whole number, a repository not on the file's own allowlist. Every entry
 * here is invented.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT, writeJson } from './fixture'

const RUN = {
  date: '2026-01-02',
  commit: 'abcdef1234567890',
  scope: 'whole repository',
  coverage_units: 12,
  agent_calls: 40,
  confirmed: { high: 1, medium: 1, low: 0 },
  fixed_in: ['1.1.1', '1.2.0'],
}

function entries(overrides: Record<string, unknown> = {}) {
  return {
    repos: ['demo-kit', 'demo-plugins'],
    runs: [RUN],
    fixed: [
      { release: '1.2.0', repo: 'demo-kit', high: 0, medium: 1, low: 0, hardening: 1 },
      { release: '1.1.1', repo: 'demo-plugins', high: 1, medium: 0, low: 0, hardening: 0 },
    ],
    ...overrides,
  }
}

function run(input: unknown, ...args: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-public-'))
  const file = path.join(dir, 'entries.json')
  writeJson(file, input)
  const r = spawnSync('node', [AUDIT, 'public-report', file, ...args], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, RF_SECURITY_RUNS: path.join(dir, 'runs') },
  })
  return { dir, status: r.status, out: `${r.stdout}${r.stderr}` }
}

function refused(input: unknown, ...messages: string[]) {
  const r = run(input)
  expect(r.status).toBe(1)
  for (const m of messages) expect(r.out).toContain(m)
  expect(r.out).toContain('nothing written')
}

describe('rf-security public-report', () => {
  it('writes markdown and JSON with the runs and the counts by release, oldest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-public-out-'))
    const out = path.join(dir, 'report.md')
    const r = run(entries(), '--out', out)
    expect(r.status).toBe(0)
    const md = fs.readFileSync(out, 'utf8')
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))
    expect(md).toContain(
      '| 2026-01-02 | `abcdef123456` | whole repository | 12 | 40 | 1 | 1 | 0 | 1.1.1, 1.2.0 |'
    )
    expect(md).toContain('| 1.1.1 | demo-plugins | 1 | 0 | 0 | 0 |')
    expect(md).toContain('| 1.2.0 | demo-kit | 0 | 1 | 0 | 1 |')
    expect(md.indexOf('| 1.1.1 |')).toBeLessThan(md.indexOf('| 1.2.0 |'))
    expect(md).toContain('| Total |  | 1 | 1 | 0 | 1 |')
    expect(md).toContain('Individual issues are not published')
    expect(md).toContain('Please request the detailed report by emailing security@rocketflare.dev')
    expect(Object.keys(json)).toEqual(['runs', 'fixed', 'totals', 'notice'])
    expect(json.notice).toContain(
      'Please request the detailed report by emailing security@rocketflare.dev'
    )
    expect(json.totals).toEqual({ critical: 0, high: 1, medium: 1, low: 0, hardening: 1 })
    expect(json.runs[0].confirmed).toEqual({ critical: 0, high: 1, medium: 1, low: 0 })
    expect(Object.keys(json.fixed[0]).sort()).toEqual(
      ['critical', 'hardening', 'high', 'low', 'medium', 'release', 'repo'].sort()
    )
  })

  it('shows a critical column only when there is a critical count', () => {
    const plain = run(entries())
    expect(plain.status).toBe(0)
    expect(plain.out).not.toContain('Critical')
    const withCritical = run(
      entries({
        runs: [{ ...RUN, fixed_in: ['1.2.0'] }],
        fixed: [
          {
            release: '1.2.0',
            repo: 'demo-kit',
            critical: 1,
            high: 0,
            medium: 0,
            low: 0,
            hardening: 0,
          },
        ],
      })
    )
    expect(withCritical.status).toBe(0)
    expect(withCritical.out).toContain('| 1.2.0 | demo-kit | 1 | 0 | 0 | 0 | 0 |')
  })

  it('takes the contact address from an optional contact field, which must be an email', () => {
    const r = run(entries({ contact: 'security@example.com' }))
    expect(r.status).toBe(0)
    expect(r.out).toContain('Please request the detailed report by emailing security@example.com')
    refused(entries({ contact: 'see our website' }), 'contact: must be an email address')
  })

  it('prints the markdown when there is no --out', () => {
    const r = run(entries())
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/^# Security audit report/)
  })

  it('refuses a line, title or description anywhere: counts only', () => {
    refused(
      entries({
        fixed: [
          {
            release: '1.2.0',
            repo: 'demo-kit',
            high: 1,
            medium: 0,
            low: 0,
            hardening: 0,
            line: 'x',
          },
        ],
      }),
      'fixed[0]: "line" describes an issue; a public report carries counts only'
    )
    refused(entries({ runs: [{ ...RUN, title: 'x' }] }), 'runs[0]: "title" describes an issue')
    refused(
      entries({ runs: [{ ...RUN, confirmed: { high: 1, medium: 1, low: 0, description: 'x' } }] }),
      'runs[0].confirmed: "description" describes an issue'
    )
  })

  it('refuses the old per-finding shape', () => {
    refused(
      {
        ...entries(),
        findings: [
          {
            severity: 'high',
            line: 'A write skipped a check.',
            release: '1.1.1',
            repo: 'demo-kit',
          },
        ],
        hardening: [{ line: 'Tighter limit.', release: '1.2.0' }],
      },
      'file: "findings" lists individual issues; a public report carries counts only',
      'file: "hardening" lists individual issues'
    )
  })

  it('refuses an unknown field anywhere, at the top level included', () => {
    refused({ ...entries(), fingerprints: ['x'] }, 'file: unknown field "fingerprints"')
    refused(entries({ runs: [{ ...RUN, proof: 3 }] }), 'runs[0]: unknown field "proof"')
    refused(
      entries({
        fixed: [
          {
            release: '1.2.0',
            repo: 'demo-kit',
            high: 1,
            medium: 0,
            low: 0,
            hardening: 0,
            extra: 1,
          },
        ],
      }),
      'fixed[0]: unknown field "extra"'
    )
  })

  it('refuses a count with no fixing release', () => {
    refused(
      entries({
        fixed: [{ release: '', repo: 'demo-kit', high: 1, medium: 0, low: 0, hardening: 0 }],
      }),
      'fixed[0].release: needs the release that fixed it'
    )
    refused(
      entries({ fixed: [{ repo: 'demo-kit', high: 1, medium: 0, low: 0, hardening: 0 }] }),
      'fixed[0]: missing "release"'
    )
    refused(
      entries({ runs: [{ ...RUN, fixed_in: [] }] }),
      'runs[0].fixed_in: confirmed counts need the release that fixed them'
    )
    refused(
      entries({ runs: [{ ...RUN, fixed_in: ['9.9.9'] }] }),
      'runs[0].fixed_in: 9.9.9 has no entry in fixed'
    )
  })

  it('refuses a negative or fractional count, and an entry that counts nothing', () => {
    refused(
      entries({
        fixed: [
          { release: '1.2.0', repo: 'demo-kit', high: -1, medium: 0.5, low: 0, hardening: 0 },
        ],
      }),
      'fixed[0].high: must be a whole number',
      'fixed[0].medium: must be a whole number'
    )
    refused(
      entries({ runs: [{ ...RUN, confirmed: { high: '1', medium: 0, low: 0 } }] }),
      'runs[0].confirmed.high: must be a whole number'
    )
    refused(
      entries({
        fixed: [{ release: '1.2.0', repo: 'demo-kit', high: 0, medium: 0, low: 0, hardening: 0 }],
      }),
      'fixed[0]: counts nothing'
    )
  })

  it('refuses a repository that is not on the allowlist, and a repeated release', () => {
    refused(
      entries({
        fixed: [
          { release: '1.0.1', repo: 'private-repo', high: 1, medium: 0, low: 0, hardening: 0 },
        ],
      }),
      '"private-repo" is not in repos'
    )
    const row = { release: '1.2.0', repo: 'demo-kit', high: 1, medium: 0, low: 0, hardening: 0 }
    refused(entries({ fixed: [row, row] }), 'fixed[1]: demo-kit 1.2.0 is listed twice')
  })

  it('refuses a multi-line scope', () => {
    refused(entries({ runs: [{ ...RUN, scope: 'one\ntwo' }] }), 'runs[0].scope: must be one line')
  })

  it('never reads a findings.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-public-findings-'))
    const file = path.join(dir, 'findings.json')
    writeJson(file, entries())
    const r = spawnSync('node', [AUDIT, 'public-report', file], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toContain('never findings.json')
  })

  it('never overwrites an existing report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-public-again-'))
    const out = path.join(dir, 'report.md')
    expect(run(entries(), '--out', out).status).toBe(0)
    const again = run(entries(), '--out', out)
    expect(again.status).toBe(1)
    expect(again.out).toContain('never overwrites')
  })
})
