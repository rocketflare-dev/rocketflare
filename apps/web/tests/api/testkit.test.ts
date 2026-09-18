/**
 * The test kit's own contract (D31).
 *
 * Two things are worth pinning here and nothing else is. **The builders refuse a `db` the
 * integration harness did not hand out** — the rule the whole of `@testkit/unit` exists to enforce,
 * and the one that stops a fake-context test being written where an isolation proof was needed. And
 * **the fake `RequestCtx` answers permissions through the REAL ability**, including the grants
 * installed plugins merged into it, because a builder whose authorisation answers were its own
 * would be a fake that disagrees with the app precisely where it matters.
 *
 * It lives in the `api` project because that is where a real handle exists; the alias wiring itself
 * is pinned by `tests/config/testkit-alias.test.ts`, which needs no database.
 */

import { createTestEnv, setupTestDatabase, stubs } from '@testkit/integration'
import { makeJobCtx, makeRequestCtx, makeToolCtx, makeWorkflowCtx } from '@testkit/unit'
import { describe, expect, it } from 'vitest'

const db = setupTestDatabase()
const TENANT = '11111111-1111-4111-8111-111111111111'

/** Everything a context builder takes, minus the handle under test. */
const base = { tenantId: TENANT }

describe('a builder refuses a db the harness did not hand out', () => {
  // The shape a fake would have: enough methods to look right, and no connection behind any of
  // them. This is exactly the object the rule exists to catch.
  const fake = { select: () => [], insert: () => [], execute: async () => [] } as never

  it('names the builder, the reason and the edit', () => {
    expect(() => makeRequestCtx({ ...base, db: fake })).toThrow(
      /makeRequestCtx\(\{ db \}\) was given a handle the integration harness did not hand out/
    )
    expect(() => makeRequestCtx({ ...base, db: fake })).toThrow(
      /import \{ setupTestDatabase \} from '@testkit\/integration'/
    )
  })

  it('refuses one for every builder, not just the request one', () => {
    expect(() => makeJobCtx({ db: fake })).toThrow(/makeJobCtx/)
    expect(() => makeToolCtx({ ...base, db: fake })).toThrow(/makeToolCtx/)
    expect(() => makeWorkflowCtx({ db: fake })).toThrow(/makeWorkflowCtx/)
  })

  it('accepts the handle setupTestDatabase returned', () => {
    expect(() => makeRequestCtx({ ...base, db })).not.toThrow()
  })
})

describe('the fake request context', () => {
  it('answers guard and can through the real ability', () => {
    const member = makeRequestCtx({ ...base, db, role: 'member' })
    const owner = makeRequestCtx({ ...base, db, role: 'owner' })

    expect(member.can('read', 'Tenant')).toBe(true)
    expect(member.can('manage', 'Tenant')).toBe(false)
    expect(() => member.guard('manage', 'Tenant')).toThrow()
    expect(() => owner.guard('manage', 'Tenant')).not.toThrow()
  })

  it('reads features from the ARRAY, never from the ability (D30)', () => {
    // A global admin holds `manage all`, which in CASL covers `access` on every `Feature:` subject.
    // `hasFeature` must still answer no — that disagreement is the incident in CONCEPTS §15.
    const admin = makeRequestCtx({ ...base, db, isGlobalAdmin: true, features: [] })
    expect(admin.can('manage', 'Tenant')).toBe(true)
    expect(admin.hasFeature('anything')).toBe(false)
    expect(makeRequestCtx({ ...base, db, features: ['x'] }).hasFeature('x')).toBe(true)
  })

  it('defers rather than awaiting, and settles on demand', async () => {
    const ctx = makeRequestCtx({ ...base, db })
    let ran = false
    ctx.defer(async () => {
      ran = true
    })
    expect(ran, 'deferred work must not run on the response path').toBe(false)
    await ctx.settle()
    expect(ran).toBe(true)
  })

  it('enqueues onto the real binding, so stubs(env) sees it', async () => {
    const env = createTestEnv()
    const ctx = makeRequestCtx({ ...base, db, env })
    await ctx.enqueue({
      type: 'activity.record',
      payload: { tenantId: TENANT, type: 'note.created', subjectType: 'ExampleNote' },
    })
    expect(stubs(env).queue.messages).toHaveLength(1)
  })

  it('is a 404 for a param that is not a UUID — never a database error', () => {
    const ctx = makeRequestCtx({ ...base, db, params: { id: 'not-a-uuid' } })
    expect(() => ctx.uuid('id')).toThrow(/Not found/)
    expect(makeRequestCtx({ ...base, db, params: { id: TENANT } }).uuid('id')).toBe(TENANT)
  })
})

describe('the background and run contexts', () => {
  it('give a job no ambient tenant — a job’s tenant is in its payload', () => {
    const ctx = makeJobCtx({ db })
    expect('tenantId' in ctx).toBe(false)
  })

  it('bind a tool to a scope rather than to a bare tenant id', () => {
    const ctx = makeToolCtx({ ...base, db, userId: null })
    expect(ctx.scope.tenantId).toBe(TENANT)
    expect(ctx.tenantId).toBe(TENANT)
  })

  it('refuse a repeated workflow step name, which the platform would silently replay', async () => {
    const ctx = makeWorkflowCtx({ db })
    await ctx.step('sync#0', async () => ({ ok: true }))
    // Thrown SYNCHRONOUSLY, before any promise exists: the guard runs when the step is ASKED for,
    // which is what makes it a programming error rather than a step failure the platform retries.
    expect(() => ctx.step('sync#0', async () => ({ ok: true }))).toThrow(
      /has already run in this instance/
    )
    expect(ctx.recorded.names).toEqual(['sync#0'])
  })
})
