/**
 * The kit's exact makeup: what core ships before an app adds anything. True of the kit and of
 * nothing made from it, because an app's first entity type or core job type changes it, so these
 * live in `kit-only` (`docs/CONCEPTS.md` §13). The properties a copy keeps (a plugin may only
 * widen a set, a registered type parses) stay in the shipped `config` tests.
 */
import type { CoreJobType } from '@rocketflare/shared/jobs'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { APP_ENTITY_TYPES } from '@/api/services/knowledge/entity-types'

describe("the kit's core", () => {
  it('registers no knowledge entity types of its own', () => {
    expect(APP_ENTITY_TYPES).toEqual([])
  })

  it('ships exactly these job types', () => {
    expectTypeOf<CoreJobType>().toEqualTypeOf<
      | 'email.send'
      | 'activity.record'
      | 'document.index'
      | 'document.convert'
      | 'document.reembed'
      | 'chat.compact'
      | 'tenant.purge'
      | 'event.deliver'
      | 'knowledge.extract'
    >()
  })
})
