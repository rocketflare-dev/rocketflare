/**
 * The rf-security runner's `ingest` and the steps after it, driven as a child process over a
 * synthetic run. A ledger that does not install must stop the pipeline: `ingest` exits non-zero,
 * and no later step reads the stale ledger while the failed step's `.next.json` waits beside it.
 */
import { describe, expect, it } from 'vitest'
import { huntedWave1, hunterResult, makeRun, planWave1 } from './fixture'

describe('rf-security ingest', () => {
  it('renames # to : in a hunter fingerprint everywhere it appears and installs the ledger', () => {
    const r = makeRun()
    const hashed = 'widget-read-unscoped:src/widgets.ts#loadWidget'
    const fixed = 'widget-read-unscoped:src/widgets.ts:loadWidget'
    const ingest = huntedWave1(r, hashed)
    expect(ingest.out).toContain(`RENAMED h01-widgets ${hashed} → ${fixed}`)
    expect(ingest.status).toBe(0)
    expect(r.has('coverage-ledger.next.json')).toBe(false)
    expect(r.unitsOf('h01-widgets')[0].result_fingerprints).toEqual([fixed])
    const [candidate] = r.read('candidates.raw.json')
    expect(candidate.fingerprint).toBe(fixed)
    expect(candidate.description).toContain(fixed)
    expect(JSON.stringify(r.read('candidates.raw.json'))).not.toContain(hashed)
    // The hunter's own result is evidence and stays as written.
    expect(JSON.stringify(r.read('agents', 'h01-widgets', 'result.json'))).toContain(hashed)
  })

  it('exits non-zero with a clear message when a fingerprint is still invalid', () => {
    const r = makeRun()
    const ingest = huntedWave1(r, 'widget read with spaces')
    expect(ingest.status).not.toBe(0)
    expect(ingest.out).toContain('ledger NOT installed')
    expect(ingest.out).toMatch(/fingerprint widget read with spaces does not match/)
  })

  it('exits non-zero when the validator refuses the next ledger', () => {
    const r = makeRun()
    planWave1(r)
    hunterResult(r, 'h01-widgets', 'src/widgets.ts')
    hunterResult(r, 'h02-gadgets', 'src/gadgets.ts')
    // A covered unit with no reviewed paths: the result is well formed, the ledger is not.
    const bad = r.read('agents', 'h02-gadgets', 'scratch', 'result.json')
    bad.units[0].reviewed_paths = []
    bad.units[0].checks = []
    r.agentWrites('h02-gadgets', bad)
    r.audit('collect')
    const ingest = r.audit('ingest')
    expect(ingest.out).toContain('validate-coverage-ledger.cjs: FAILED')
    expect(ingest.out).toContain('ingest: nothing installed')
    expect(ingest.status).toBe(1)
    expect(r.has('coverage-ledger.next.json')).toBe(true)
  })
})

describe('rf-security leftover .next.json', () => {
  it('consolidate refuses while a failed ingest left coverage-ledger.next.json', () => {
    const r = makeRun()
    expect(huntedWave1(r, 'bad fingerprint').status).not.toBe(0)
    const consolidate = r.audit('consolidate')
    expect(consolidate.status).not.toBe(0)
    expect(consolidate.out).toContain(
      'coverage-ledger.next.json is left over from a failed `ingest`'
    )
    expect(r.has('candidates.consolidated.json')).toBe(false)
    // The step that wrote it may run again (here it fails again, for the same reason).
    const again = r.audit('ingest')
    expect(again.out).not.toContain('left over')
    expect(again.out).toContain('ledger NOT installed')
  })

  it('discard-next sets a leftover aside (renamed, never deleted) and unblocks the run', () => {
    const r = makeRun()
    expect(huntedWave1(r, 'bad fingerprint').status).not.toBe(0)
    const status = r.audit('status')
    expect(status.out).toContain('LEFTOVER coverage-ledger.next.json (from `ingest`)')
    const discard = r.audit('discard-next')
    expect(discard.status).toBe(0)
    expect(r.has('coverage-ledger.next.json')).toBe(false)
    expect(r.has('coverage-ledger.discarded-1.json')).toBe(true)
    expect(r.audit('consolidate').status).toBe(0)
  })
})
