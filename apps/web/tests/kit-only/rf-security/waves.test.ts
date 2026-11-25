/**
 * Between waves in the rf-security runner: `critic` puts a critic's units in the ledger, `plan-next`
 * writes the next wave's plan, and `hunters` assigns it. Every ledger each step writes must pass
 * upstream's validator (planned units carry no `unresolved`; `attempts` holds only archived,
 * finished attempts). Plus `status` and `budget` over the same synthetic run.
 */
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { huntedWave1, makeRun, type Run, writeJson } from './fixture'

function criticSays(r: Run, reassign: string[] = []) {
  expect(r.audit('consolidate').status).toBe(0)
  r.agentWrites('c-wave1', {
    missing_units: [
      {
        surface: 'widget export to a file',
        boundary: 'src/widgets.ts#saveWidget',
        subsystem: 'src',
        attack_class: 'ATTACK-CLASSES.md#Access control',
        starting_paths: ['src/widgets.ts'],
        selected_companion_blocks: [],
        excluded_blocks: [],
        reason: 'saveWidget is reachable and no unit covers it.',
      },
    ],
    reassign_ids: reassign,
    resolved_prior_leads: [],
    stop: false,
  })
  r.audit('collect')
}

const gadgetUnit = (r: Run) => r.unitsOf('h02-gadgets')[0].coverage_id

describe('rf-security critic', () => {
  it('plans a new unit with an empty unresolved and archives a reassigned attempt', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    const gadget = gadgetUnit(r)
    criticSays(r, [gadget])
    const critic = r.audit('critic', 'c-wave1')
    expect(critic.out).toContain('validate-coverage-ledger.cjs: ok')
    expect(critic.status).toBe(0)
    expect(r.has('coverage-ledger.next.json')).toBe(false)
    const planned = r.ledger().filter(u => u.status === 'planned')
    expect(planned).toHaveLength(2)
    for (const u of planned) {
      expect(u.unresolved).toEqual([])
      expect(u.agent_id).toBeNull()
      expect(u.wave).toBe(2)
    }
    const added = planned.find(u => u.surface === 'widget export to a file')
    expect(added.critic_reason).toBe('saveWidget is reachable and no unit covers it.')
    const reassigned = r.ledger().find(u => u.coverage_id === gadget)
    expect(reassigned.attempts).toEqual([
      expect.objectContaining({
        wave: 1,
        status: 'covered',
        agent_id: 'h02-gadgets',
        reassignment_reason: 'c-wave1: did not close',
      }),
    ])
    expect(reassigned.reviewed_paths).toEqual([])
  })

  it('--defer records new and reassigned units as deferred with a reason', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    const gadget = gadgetUnit(r)
    criticSays(r, [gadget])
    const critic = r.audit('critic', 'c-wave1', '--defer')
    expect(critic.status).toBe(0)
    const deferred = r.ledger().filter(u => u.status === 'deferred')
    expect(deferred).toHaveLength(2)
    for (const u of deferred) expect(u.unresolved.length).toBeGreaterThan(0)
    expect(r.ledger().find(u => u.coverage_id === gadget).attempts).toHaveLength(1)
  })
})

describe('rf-security plan-next and wave 2 hunters', () => {
  it('writes the next plan from the planned units, keeping the previous plan', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    criticSays(r, [gadgetUnit(r)])
    expect(r.audit('critic', 'c-wave1').status).toBe(0)
    const wave1 = fs.readFileSync(r.file('plan.json'), 'utf8')
    const next = r.audit('plan-next')
    expect(next.status).toBe(0)
    expect(fs.readFileSync(r.file('plan-wave1.json'), 'utf8')).toBe(wave1)
    const plan = r.read('plan.json')
    expect(plan.wave).toBe(2)
    expect(plan.hunters.map((h: any) => h.id)).toEqual([
      'h03-gadget-pricing',
      'h04-widget-export-to-a-file',
    ])
    const planned = r
      .ledger()
      .filter(u => u.status === 'planned')
      .map(u => u.coverage_id)
    expect(plan.hunters.flatMap((h: any) => h.units).sort()).toEqual(planned.sort())
  })

  it('assigns a { id, units } plan without inventing attempts, and the ledger validates', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    const gadget = gadgetUnit(r)
    criticSays(r, [gadget])
    expect(r.audit('critic', 'c-wave1').status).toBe(0)
    expect(r.audit('plan-next').status).toBe(0)
    const hunters = r.audit('hunters', r.file('plan.json'))
    expect(hunters.out).toContain('validate-coverage-ledger.cjs: ok')
    expect(hunters.status).toBe(0)
    const assigned = r.ledger().filter(u => u.status === 'in_progress')
    expect(assigned).toHaveLength(2)
    const added = assigned.find(u => u.coverage_id !== gadget)
    expect(added.attempts).toEqual([])
    // The reassigned unit keeps only its archived wave-1 attempt.
    const again = assigned.find(u => u.coverage_id === gadget)
    expect(again.attempts.map((a: any) => a.agent_id)).toEqual(['h02-gadgets'])
    expect(again.agent_id).toBe('h03-gadget-pricing')
    expect(r.has('agents', 'h04-widget-export-to-a-file', 'prompt.md')).toBe(true)
  })

  it('refuses a plan that gives a unit back to its earlier owner', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    const gadget = gadgetUnit(r)
    criticSays(r, [gadget])
    expect(r.audit('critic', 'c-wave1').status).toBe(0)
    writeJson(r.file('plan-2.json'), { wave: 2, hunters: [{ id: 'h02-gadgets', units: [gadget] }] })
    const hunters = r.audit('hunters', r.file('plan-2.json'))
    expect(hunters.status).not.toBe(0)
    expect(hunters.out).toContain('use a fresh hunter id')
  })

  it('hunters with no plan names the expected path', () => {
    const r = makeRun()
    const hunters = r.audit('hunters')
    expect(hunters.status).not.toBe(0)
    expect(hunters.out).toContain('usage: hunters <plan.json>')
    expect(hunters.out).toContain(r.file('plan.json'))
  })
})

describe('rf-security status and budget', () => {
  it('budget counts reconnaissance agents that wrote notes', () => {
    const r = makeRun()
    fs.mkdirSync(r.file('agents', 'recon-1', 'scratch'), { recursive: true })
    fs.writeFileSync(r.file('agents', 'recon-1', 'scratch', 'map.md'), '# invented map\n')
    fs.mkdirSync(r.file('agents', 'recon-2', 'scratch'), { recursive: true })
    const budget = r.audit('budget')
    expect(budget.status).toBe(0)
    expect(budget.out).toMatch(/reconnaissance: 1,/)
    expect(budget.out).toMatch(/total: 1\b/)
  })

  it('status shows the phase, units, waiting agents, leftovers and budget on one screen', () => {
    const r = makeRun()
    expect(huntedWave1(r).status).toBe(0)
    expect(r.audit('consolidate').status).toBe(0)
    const status = r.audit('status')
    expect(status.status).toBe(0)
    expect(status.out).toContain('phase: verifying')
    expect(status.out).toContain('units: 2 {"covered":1,"candidate":1}')
    expect(status.out).toContain('agents hunter: 2 done, 0 waiting')
    expect(status.out).toContain('waiting: c-wave1 v01')
    expect(status.out).toMatch(/budget: 2 of 50 calls spent \(2 hunters\); hunters 2 of 21/)
    expect(status.out).not.toContain('LEFTOVER')
  })
})
