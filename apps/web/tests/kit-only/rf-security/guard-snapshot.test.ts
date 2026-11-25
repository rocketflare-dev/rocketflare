/**
 * `guard snapshot` lists what agents must not change before a wave. A file directly under
 * agents/ is not an agent: the snapshot skips it with a warning (and records it, so one that
 * appears during a wave fails `guard check`) instead of failing.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeRun } from './fixture'

describe('rf-security guard snapshot', () => {
  it('skips a non-directory entry in agents/ with a warning', () => {
    const r = makeRun()
    fs.mkdirSync(r.file('agents', 'h01-widgets', 'scratch'), { recursive: true })
    fs.writeFileSync(r.file('agents', 'notes.txt'), 'an invented stray file\n')
    const snap = r.audit('guard', 'snapshot', '--label', 'wave1')
    expect(snap.status).toBe(0)
    expect(snap.out).toContain('WARNING agents/notes.txt is not an agent directory; skipped')
    expect(r.read('guard-wave1.json').strays).toEqual(['notes.txt'])
  })
})
