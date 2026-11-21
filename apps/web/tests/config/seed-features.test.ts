/**
 * `pnpm seed --feature <key>[=on|off][@<tenant-slug>]`: the parse, and the refusal of a key the
 * registry does not know. The writes are proven on Postgres in `tests/api/seed-features.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { featureKey, parseSeedFeatureArgs } from '../../scripts/lib/seed-features'

describe('parseSeedFeatureArgs', () => {
  it('reads both spellings, the on/off suffix and a tenant slug, repeatably', () => {
    expect(
      parseSeedFeatureArgs([
        '--demo',
        '--feature',
        'hotel',
        '--feature=reports=off',
        '--feature',
        'hotel=on@sunshine-hotel',
      ])
    ).toEqual([
      { key: 'hotel', enabled: true },
      { key: 'reports', enabled: false },
      { key: 'hotel', enabled: true, tenantSlug: 'sunshine-hotel' },
    ])
  })

  it('is empty without --feature', () => {
    expect(parseSeedFeatureArgs(['--demo'])).toEqual([])
  })

  it('refuses a missing or malformed value by name', () => {
    expect(() => parseSeedFeatureArgs(['--feature'])).toThrow(/--feature needs a value/)
    expect(() => parseSeedFeatureArgs(['--feature', '--demo'])).toThrow(/needs a value/)
    expect(() => parseSeedFeatureArgs(['--feature=hotel=maybe'])).toThrow(
      /--feature hotel=maybe: expected/
    )
  })
})

describe('featureKey', () => {
  it('accepts a registered key and names the known ones for any other', () => {
    expect(featureKey('knowledge-facts')).toBe('knowledge-facts')
    expect(() => featureKey('no-such-flag')).toThrow(
      /unknown feature flag "no-such-flag" \(known: .*knowledge-facts/
    )
  })
})
