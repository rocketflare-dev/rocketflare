/**
 * `latencyFactor()` (`tests/helpers/latency.ts`), the one scale `vitest.config.ts` puts on the
 * test, hook and teardown limits: the target's factor, raised by `TEST_LATENCY_FACTOR` on a slow
 * machine and never lowered by it.
 */
import { describe, expect, it } from 'vitest'
import { latencyFactor } from '../helpers/latency'

describe('latencyFactor: the one scale on every vitest time limit', () => {
  it('follows the target: 1 under postgres, 4 under neon, 12 on a gate branch', () => {
    expect(latencyFactor({})).toBe(1)
    expect(latencyFactor({ DATABASE_DRIVER: 'postgres' })).toBe(1)
    expect(latencyFactor({ DATABASE_DRIVER: 'neon' })).toBe(4)
    expect(latencyFactor({ TEST_DATABASE_EPHEMERAL: '1', DATABASE_DRIVER: 'neon' })).toBe(12)
  })

  it('TEST_LATENCY_FACTOR raises it on a slow machine', () => {
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '4' })).toBe(4)
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '2.5', DATABASE_DRIVER: 'postgres' })).toBe(2.5)
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '6', DATABASE_DRIVER: 'neon' })).toBe(6)
  })

  it('never lowers it: a sandbox setting it keeps the gate branch at 12', () => {
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '4', TEST_DATABASE_EPHEMERAL: '1' })).toBe(12)
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '0.5' })).toBe(1)
  })

  it('an empty value is no override', () => {
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '' })).toBe(1)
    expect(latencyFactor({ TEST_LATENCY_FACTOR: '  ' })).toBe(1)
  })

  it('anything but a positive number fails loudly', () => {
    for (const bad of ['fast', '0', '-2', 'Infinity', 'NaN']) {
      expect(() => latencyFactor({ TEST_LATENCY_FACTOR: bad })).toThrow(/TEST_LATENCY_FACTOR/)
    }
  })
})
