/**
 * How much every vitest time limit scales on this target (`vitest.config.ts` — the ONE place
 * timeouts scale). Computed from the target: 1 locally under `postgres`, 4 under `neon` through
 * the local proxy, 12 on a real Neon gate branch (`TEST_DATABASE_EPHEMERAL=1`).
 *
 * `TEST_LATENCY_FACTOR` raises it for a slow MACHINE rather than a slow link — a coding sandbox
 * whose agent runs one test by hand, outside the gate, on a fraction of a laptop's CPU. It never
 * lowers it: the effective factor is the larger of the two, so a sandbox setting it cannot shorten
 * the gate's 12. Anything but a positive finite number throws, so a typo cannot silently leave a
 * slow machine on the 5 s limit. Pure.
 */
export function latencyFactor(env: Record<string, string | undefined>): number {
  const computed = env.TEST_DATABASE_EPHEMERAL === '1' ? 12 : env.DATABASE_DRIVER === 'neon' ? 4 : 1
  const raw = env.TEST_LATENCY_FACTOR?.trim()
  if (!raw) return computed
  const override = Number(raw)
  if (!Number.isFinite(override) || override <= 0) {
    throw new Error(`TEST_LATENCY_FACTOR must be a positive number, got '${raw}'`)
  }
  return Math.max(computed, override)
}
