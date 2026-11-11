/**
 * `audit.mjs public-report`: a publishable report from a hand-curated entries file. It carries
 * only the allowlisted fields and refuses the whole file, writing nothing, on anything else: an
 * unknown field, an item with no fixing release, a repository not on the file's own allowlist.
 * Every entry here is invented.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUDIT, writeJson } from './fixture'

function entries(overrides: Record<string, unknown> = {}) {
  return {
    repos: ['demo-kit', 'demo-plugins'],
    runs: [
      {
        date: '2026-01-02',
        commit: 'abcdef1234567890',
        scope: 'whole repository',
        coverage_units: 12,
        agent_calls: 40,
      },
    ],
    findings: [
      {
        severity: 'medium',
        line: 'A list route ignored a filter.',
        release: '1.2.0',
        repo: 'demo-kit',
      },
      {
        severity: 'high',
        line: 'A write skipped a role check.',
        release: '1.1.1',
        repo: 'demo-plugins',
      },
    ],
    hardening: [{ line: 'Tighter upload size limit.', release: '1.2.0' }],
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

describe('rf-security public-report', () => {
  it('writes markdown and JSON from the allowlisted fields, highest severity first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-security-public-out-'))
    const out = path.join(dir, 'report.md')
    const r = run(entries(), '--out', out)
    expect(r.status).toBe(0)
    const md = fs.readFileSync(out, 'utf8')
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))
    expect(md).toContain('| 2026-01-02 | `abcdef123456` | whole repository | 12 | 40 |')
    expect(md).toContain('1 high, 1 medium')
    expect(md.indexOf('A write skipped')).toBeLessThan(md.indexOf('A list route'))
    expect(md).toContain('| 1.2.0 | Tighter upload size limit. |')
    expect(Object.keys(json)).toEqual(['runs', 'counts', 'findings', 'hardening'])
    expect(json.counts).toEqual({ high: 1, medium: 1 })
    expect(Object.keys(json.findings[0]).sort()).toEqual(['line', 'release', 'repo', 'severity'])
  })

  it('prints the markdown when there is no --out', () => {
    const r = run(entries())
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/^# Security audit report/)
  })

  it('refuses a finding with no fixing release', () => {
    const r = run(
      entries({
        findings: [{ severity: 'low', line: 'Open item.', release: '', repo: 'demo-kit' }],
      })
    )
    expect(r.status).toBe(1)
    expect(r.out).toContain('findings[0].release: needs the release that fixed it')
    expect(r.out).toContain('nothing written')
  })

  it('refuses a hardening item with no release', () => {
    const r = run(entries({ hardening: [{ line: 'Pending change.' }] }))
    expect(r.status).toBe(1)
    expect(r.out).toContain('hardening[0]: missing "release"')
  })

  it('refuses a repository that is not on the allowlist', () => {
    const r = run(
      entries({
        findings: [{ severity: 'high', line: 'Fixed.', release: '1.0.1', repo: 'private-repo' }],
      })
    )
    expect(r.status).toBe(1)
    expect(r.out).toContain('"private-repo" is not in repos')
  })

  it('refuses an unknown field anywhere, at the top level included', () => {
    const extra = run(
      entries({
        findings: [
          { severity: 'high', line: 'Fixed.', release: '1.0.1', repo: 'demo-kit', proof: 'x' },
        ],
      })
    )
    expect(extra.status).toBe(1)
    expect(extra.out).toContain('findings[0]: unknown field "proof"')
    const top = run({ ...entries(), fingerprints: ['x'] })
    expect(top.status).toBe(1)
    expect(top.out).toContain('file: unknown field "fingerprints"')
    const inRun = run(entries({ runs: [{ ...entries().runs[0], findings_count: 3 }] }))
    expect(inRun.status).toBe(1)
    expect(inRun.out).toContain('runs[0]: unknown field "findings_count"')
  })

  it('refuses a multi-line description and an unknown severity', () => {
    const r = run(
      entries({
        findings: [{ severity: 'severe', line: 'one\ntwo', release: '1.0.1', repo: 'demo-kit' }],
      })
    )
    expect(r.status).toBe(1)
    expect(r.out).toContain('findings[0].severity')
    expect(r.out).toContain('findings[0].line: must be one line')
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
