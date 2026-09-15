/**
 * Feature-flag evaluation (D30) — pure, no database, no app.
 *
 * The golden vectors below are the most important assertion in this file. `featureBucket` is a WIRE
 * FORMAT: changing the hash, the separator or the modulus silently reshuffles every live rollout, so
 * tenants already inside one would fall out of it. If this test fails after a refactor, the refactor
 * is wrong — not the vectors.
 */
import {
  evaluateFeatures,
  evaluateFlag,
  FEATURE_FLAGS,
  type FeatureFlagEvaluation,
  featureBucket,
} from '@rocketflare/shared/features'
import { describe, expect, it } from 'vitest'

const KEY = 'example-feature' as const
const ctx = (over: Partial<Parameters<typeof evaluateFlag>[2]> = {}) => ({
  tenantId: 'tenant-1',
  userId: 'user-1',
  environmentEnabled: [] as string[],
  ...over,
})

const row = (over: Partial<FeatureFlagEvaluation> = {}): FeatureFlagEvaluation => ({
  key: KEY,
  state: 'off',
  rolloutPercent: 0,
  rolloutUnit: 'tenant',
  override: null,
  ...over,
})

/** Deterministic ids — never `Math.random`, or a distribution assertion can flake. */
const ids = (n: number, prefix = 'id') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

describe('featureBucket', () => {
  it('matches its frozen vectors (changing these reshuffles every live rollout)', () => {
    expect(featureBucket('example-feature', 'tenant-1')).toBe(78)
    expect(featureBucket('example-feature', 'tenant-2')).toBe(59)
    expect(featureBucket('example-feature', 'user-1')).toBe(97)
    expect(featureBucket('billing', 'tenant-1')).toBe(8)
    expect(featureBucket('', '')).toBe(53)
  })

  it('is always a bucket in 0..99', () => {
    for (const id of ids(500)) {
      const bucket = featureBucket(KEY, id)
      expect(Number.isInteger(bucket)).toBe(true)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(100)
    }
  })

  it('is deterministic', () => {
    expect(featureBucket(KEY, 'tenant-9')).toBe(featureBucket(KEY, 'tenant-9'))
  })

  it('spreads roughly evenly across the 100 buckets', () => {
    const counts = new Array<number>(100).fill(0)
    for (const id of ids(10_000)) counts[featureBucket(KEY, id)]++
    // Expected 100 each; a generous band, but a broken hash (constant, or clustered) blows past it.
    for (const count of counts) {
      expect(count).toBeGreaterThan(50)
      expect(count).toBeLessThan(160)
    }
  })

  it('puts a different cohort in each flag, so the same few are not always first', () => {
    const cohort = (key: string) => new Set(ids(400).filter(id => featureBucket(key, id) < 10))
    const a = cohort('feature-a')
    const b = cohort('feature-b')
    expect(a.size).toBeGreaterThan(0)
    expect(b.size).toBeGreaterThan(0)
    const shared = [...a].filter(id => b.has(id)).length
    // Independent cohorts overlap around 1% of the population; identical ones would overlap wholly.
    expect(shared).toBeLessThan(a.size * 0.5)
  })
})

describe('rollout monotonicity', () => {
  /**
   * The property the whole design leans on: raising a percentage only ever ADDS units. It holds
   * because the bucket ignores the percentage — which is why the percentage must never be hashed in.
   */
  it('never drops a unit as the percentage rises, for any unit, 0 → 100', () => {
    for (const id of ids(200, 'tenant')) {
      let wasIn = false
      for (let percent = 0; percent <= 100; percent++) {
        const isIn = evaluateFlag(KEY, row({ state: 'rollout', rolloutPercent: percent }), {
          ...ctx(),
          tenantId: id,
        })
        if (wasIn) expect(isIn, `${id} fell out of the rollout at ${percent}%`).toBe(true)
        wasIn = isIn
      }
      expect(wasIn, `${id} was not in the rollout at 100%`).toBe(true)
    }
  })

  it('includes nobody at 0% and everybody at 100%', () => {
    for (const id of ids(50, 'tenant')) {
      const at = (percent: number) =>
        evaluateFlag(KEY, row({ state: 'rollout', rolloutPercent: percent }), {
          ...ctx(),
          tenantId: id,
        })
      expect(at(0)).toBe(false)
      expect(at(100)).toBe(true)
    }
  })
})

describe('evaluateFlag precedence', () => {
  it('falls back to the registry default with no stored row', () => {
    expect(evaluateFlag(KEY, null, ctx())).toBe(FEATURE_FLAGS[KEY].defaultState === 'on')
  })

  it('reads the platform state', () => {
    expect(evaluateFlag(KEY, row({ state: 'on' }), ctx())).toBe(true)
    expect(evaluateFlag(KEY, row({ state: 'off' }), ctx())).toBe(false)
  })

  it('lets an override beat the state in BOTH directions', () => {
    expect(evaluateFlag(KEY, row({ state: 'off', override: true }), ctx())).toBe(true)
    expect(evaluateFlag(KEY, row({ state: 'on', override: false }), ctx())).toBe(false)
  })

  it('lets an override beat a rollout the tenant is outside of', () => {
    const outside = row({ state: 'rollout', rolloutPercent: 0, override: true })
    expect(evaluateFlag(KEY, outside, ctx())).toBe(true)
  })

  it('counts the unit the flag asks for', () => {
    // tenant-1 buckets at 78 and user-2 at 40, so an 50% rollout includes the user and not the
    // organisation — the same request, two answers, decided only by the flag's unit.
    const at50 = (unit: 'tenant' | 'user') =>
      evaluateFlag(KEY, row({ state: 'rollout', rolloutPercent: 50, rolloutUnit: unit }), {
        ...ctx(),
        userId: 'user-2',
      })
    expect(at50('tenant')).toBe(false)
    expect(at50('user')).toBe(true)
  })

  it('fails closed when the unit it counts is missing', () => {
    const rollout = row({ state: 'rollout', rolloutPercent: 100 })
    expect(evaluateFlag(KEY, rollout, ctx({ tenantId: null }))).toBe(false)
    expect(evaluateFlag(KEY, { ...rollout, rolloutUnit: 'user' }, ctx({ userId: null }))).toBe(
      false
    )
  })
})

describe('the environment layer', () => {
  /**
   * Layer 1 is the release gate and beats everything, including an override — because "this
   * deployment does not ship that surface" is not a per-customer decision.
   */
  const gated = { ...FEATURE_FLAGS[KEY], environmentGated: true }

  it('is skipped entirely for a flag that is not environment-gated', () => {
    expect(evaluateFlag(KEY, row({ state: 'on' }), ctx({ environmentEnabled: [] }))).toBe(true)
  })

  it('beats the state and the override when the key is absent from the deployment', () => {
    const registry = FEATURE_FLAGS as Record<string, typeof gated>
    const original = registry[KEY]
    registry[KEY] = gated
    try {
      expect(evaluateFlag(KEY, row({ state: 'on' }), ctx({ environmentEnabled: [] }))).toBe(false)
      expect(
        evaluateFlag(KEY, row({ state: 'off', override: true }), ctx({ environmentEnabled: [] }))
      ).toBe(false)
      // …and lets it through once the deployment lists it.
      expect(evaluateFlag(KEY, row({ state: 'on' }), ctx({ environmentEnabled: [KEY] }))).toBe(true)
    } finally {
      registry[KEY] = original
    }
  })
})

describe('evaluateFeatures', () => {
  it('returns only the keys that are on, in registry order', () => {
    expect(evaluateFeatures([row({ state: 'on' })], ctx())).toEqual([KEY])
    expect(evaluateFeatures([row({ state: 'off' })], ctx())).toEqual([])
  })

  it('treats a missing row as the registry default', () => {
    expect(evaluateFeatures([], ctx())).toEqual(
      FEATURE_FLAGS[KEY].defaultState === 'on' ? [KEY] : []
    )
  })
})
