/**
 * A MATERIAL Phase 5 replacement needs a fresh verifier before the record stands (upstream). The
 * runner's `reverify <fingerprint>` writes that verifier's brief from the original's, and
 * `apply-reverify <id>` installs its record only when it is a valid verdict for the same
 * fingerprint. Synthetic run; the agents' answers are written by the test.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { huntedWave1, makeRun, type Run, record } from './fixture'

const FP = 'widget-read-unscoped:src/widgets.ts:loadWidget'

/** Wave 1 → verifier v01 → findings → reviewer r01 replaces the record materially. */
function reviewed(r: Run) {
  expect(huntedWave1(r, FP).status).toBe(0)
  expect(r.audit('consolidate').status).toBe(0)
  r.agentWrites('v01', { decision: 'needs_validation', record: record(FP) })
  r.audit('collect')
  expect(r.audit('findings').status).toBe(0)
  expect(r.audit('review').status).toBe(0)
  r.agentWrites('r01', {
    results: [
      {
        decision: 'replace',
        reason: 'material: the write path has the same gap.',
        record: record(FP, 'Widget reads and writes skip the owner check'),
      },
    ],
  })
  r.audit('collect')
  return r.audit('apply-review')
}

describe('rf-security reverify', () => {
  it('apply-review names the reverify command for a material replacement', () => {
    const r = makeRun()
    const applied = reviewed(r)
    expect(applied.status).toBe(0)
    expect(applied.out).toContain(`MATERIAL ${FP}`)
    expect(applied.out).toContain(`reverify ${FP}`)
  })

  it('writes v01b from v01 with every id and path renamed and the reviewed record as candidate', () => {
    const r = makeRun()
    reviewed(r)
    const re = r.audit('reverify', FP)
    expect(re.status).toBe(0)
    expect(re.out).toContain('v01b: fresh verifier')
    const brief = fs.readFileSync(r.file('agents', 'v01b', 'prompt.md'), 'utf8')
    const [before, rest] = brief.split('# The candidate')
    const [candidate, after] = rest.split('# Linked coverage-unit checks')
    expect(`${before}${after}`).not.toMatch(/(?<![A-Za-z0-9_-])v01(?![A-Za-z0-9_-])/)
    expect(after).toContain('Your ID is v01b.')
    expect(after).toContain(`--agent v01b\n`)
    expect(after).toContain(r.file('agents', 'v01b', 'scratch'))
    expect(candidate).toContain('Widget reads and writes skip the owner check')
    expect(candidate).toContain('reviewer r01')
    expect(candidate).toContain('agents/v01/')
    // A second reverify takes the next free suffix.
    expect(r.audit('reverify', FP).out).toContain('v01c: fresh verifier')
  })

  it('collect picks up v01b as a verifier and apply-reverify installs its record', () => {
    const r = makeRun()
    reviewed(r)
    r.audit('reverify', FP)
    const fresh = {
      ...record(FP, 'Widget reads skip the owner check'),
      verdict: 'rejected',
      reason: 'The db layer scopes by owner.',
    }
    delete (fresh as any).blockers
    delete (fresh as any).validation_plan
    r.agentWrites('v01b', { decision: 'rejected', record: fresh })
    const collect = r.audit('collect')
    expect(collect.out).toMatch(/v01b.*verifier.*collected/)
    expect(r.has('agents', 'v01b', 'verdict.json')).toBe(true)
    const apply = r.audit('apply-reverify', 'v01b')
    expect(apply.out).toContain('validate-findings.cjs: ok')
    expect(apply.status).toBe(0)
    const [installed] = r.read('findings.json')
    expect(installed).toEqual(fresh)
    expect(r.read('reverify.json').v01b.decision).toBe('rejected')
  })

  it('findings rerun after apply-reverify keeps the fresh record and records both checks', () => {
    const r = makeRun()
    reviewed(r)
    r.audit('reverify', FP)
    const fresh = {
      ...record(FP, 'Widget reads skip the owner check'),
      verdict: 'rejected',
      reason: 'The db layer scopes by owner.',
    }
    delete (fresh as any).blockers
    delete (fresh as any).validation_plan
    r.agentWrites('v01b', { decision: 'rejected', record: fresh })
    r.audit('collect')
    expect(r.audit('apply-reverify', 'v01b').status).toBe(0)
    const again = r.audit('findings')
    expect(again.status).toBe(0)
    const [kept] = r.read('findings.json')
    expect(kept.verdict).toBe('rejected')
    expect(kept.title).toBe('Widget reads skip the owner check')
    const checks = r
      .read('coverage-ledger.json')
      .flatMap((u: { local_checks: { agent_id: string }[] }) => u.local_checks)
      .map((k: { agent_id: string }) => k.agent_id)
    expect(checks).toEqual(expect.arrayContaining(['v01', 'v01b']))
  })

  it('apply-reverify refuses a decision that is not a verdict, or another fingerprint', () => {
    const r = makeRun()
    reviewed(r)
    r.audit('reverify', FP)
    r.agentWrites('v01b', { decision: 'unsure', record: record(FP) })
    r.audit('collect')
    const unsure = r.audit('apply-reverify', 'v01b')
    expect(unsure.status).not.toBe(0)
    expect(unsure.out).toContain('decision is unsure')
    expect(r.read('findings.json')[0].title).toBe('Widget reads and writes skip the owner check')

    r.audit('reverify', FP)
    r.agentWrites('v01c', {
      decision: 'needs_validation',
      record: record('another-root-cause:src/widgets.ts'),
    })
    r.audit('collect')
    const other = r.audit('apply-reverify', 'v01c')
    expect(other.status).not.toBe(0)
    expect(other.out).toContain('is not widget-read-unscoped')
  })

  it('reverify refuses a record no reviewer replaced', () => {
    const r = makeRun()
    expect(huntedWave1(r, FP).status).toBe(0)
    expect(r.audit('consolidate').status).toBe(0)
    r.agentWrites('v01', { decision: 'needs_validation', record: record(FP) })
    r.audit('collect')
    expect(r.audit('findings').status).toBe(0)
    const re = r.audit('reverify', FP)
    expect(re.status).not.toBe(0)
    expect(re.out).toContain('no reviewer replaced')
  })
})
