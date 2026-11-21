/**
 * The test factories' ids are slug-safe: a tenant `createTestTenant` makes can be sent through a
 * validated request by its slug. `uniqueId()` once joined with `_` (and kept base64url's `_`), so
 * `test-org-mfx1_ab12` failed the kit's own `SLUG_RE` for a reason that had nothing to do with the
 * test that sent it. Pure: no database.
 */
import { SLUG_RE, slugify } from '@rocketflare/shared/tenants'
import { describe, expect, it } from 'vitest'
import { testTenantSlug, uniqueId } from '../helpers/auth'

describe('test factory ids', () => {
  it('a factory tenant slug passes SLUG_RE and is slug-stable, every time', () => {
    for (let i = 0; i < 500; i++) {
      const slug = testTenantSlug(uniqueId().toLowerCase())
      expect(slug).toMatch(SLUG_RE)
      expect(slugify(slug)).toBe(slug)
    }
  })

  it('uniqueId() is lower-case letters and digits around one hyphen, and does not repeat', () => {
    const ids = Array.from({ length: 500 }, () => uniqueId())
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
