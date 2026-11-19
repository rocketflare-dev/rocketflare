/**
 * `prefer` settles a conflict only as far as the reader may settle each side of it. Choosing one
 * fact rejects the others, so a member may prefer only when every visible fact it would reject is
 * an item they review themselves and that no other person has confirmed. Anything else is a 403
 * `fact_conflict_needs_admin` with nothing written and nothing nudged: the pair stays conflicting
 * for an admin, who may prefer either side. A member can still reject their own side.
 */
import { factReviewResponseSchema } from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { setTenantOverride } from '@/api/services/features'
import { knowledgeFacts } from '@/db/schema'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { linkConflict, seedDocument, seedEntity, seedFact } from '../../helpers/knowledge-facts'
import { json, request } from '../../helpers/request'
import { createTestEnv, stubs } from '../../mocks/bindings'

const db = setupTestDatabase()
const env = createTestEnv()

interface Person {
  userId: string
  cookie: Record<string, string>
}

let tenantId: string
let admin: Person
let member: Person
let adminDoc: string
let memberDoc: string

async function person(tenant: string, role: 'admin' | 'member'): Promise<Person> {
  const user = await createTestUser(db)
  await linkUserToTenant(db, user.id, tenant, role)
  return {
    userId: user.id,
    cookie: sessionCookieHeader(await createTestSession(db, user.id, tenant)),
  }
}

const prefer = (id: string, who: Person) =>
  request(
    `/api/knowledge/facts/${id}/review`,
    { method: 'POST', headers: who.cookie },
    { env, json: { action: 'prefer' } }
  )

const rowOf = (id: string) =>
  db.query.knowledgeFacts.findFirst({
    where: and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, id)),
  })

const nudgesFor = (id: string) =>
  stubs(env)
    .hub.broadcasts.filter(b => b.tenantId === tenantId && b.args[0] === 'broadcast')
    .filter(b => (b.args[1] as { payload?: { id?: string } }).payload?.id === id)

/** The member's own fact, in conflict with one other fact shaped by `other`. */
async function pair(other: {
  documentId: string
  reviewerUserId: string | null
  confirmedBy?: string
}) {
  const e = await seedEntity(db, { tenantId, name: `Prefer ${crypto.randomUUID()}` })
  const mine = await seedFact(db, {
    tenantId,
    entityId: e.id,
    documentId: memberDoc,
    value: 1,
    reviewerUserId: member.userId,
  })
  const theirs = await seedFact(db, {
    tenantId,
    entityId: e.id,
    documentId: other.documentId,
    value: 2,
    reviewerUserId: other.reviewerUserId,
  })
  if (other.confirmedBy) {
    await db
      .update(knowledgeFacts)
      .set({ confirmedBy: other.confirmedBy, confirmedAt: new Date() })
      .where(eq(knowledgeFacts.id, theirs.id))
  }
  await linkConflict(db, tenantId, mine.id, theirs.id)
  return { mine, theirs }
}

async function expectRefusedAndUnchanged(mineId: string, theirsId: string) {
  const res = await prefer(mineId, member)
  expect(res.status).toBe(403)
  expect(await json(res)).toMatchObject({ statusCode: 403, code: 'fact_conflict_needs_admin' })
  expect(await rowOf(theirsId)).toMatchObject({ state: 'conflicting', conflictsWith: [mineId] })
  expect(await rowOf(mineId)).toMatchObject({ state: 'conflicting', confirmedBy: null })
  expect(nudgesFor(mineId)).toEqual([])
}

beforeAll(async () => {
  tenantId = (await createTestTenant(db)).id
  admin = await person(tenantId, 'admin')
  member = await person(tenantId, 'member')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, admin.userId)
  adminDoc = (await seedDocument(db, { tenantId, title: 'Signed', ownerUserId: admin.userId })).id
  memberDoc = (await seedDocument(db, { tenantId, title: 'Note', ownerUserId: member.userId })).id
})

describe('prefer by a member', () => {
  it('is refused when a fact it would reject is reviewed by someone else', async () => {
    const { mine, theirs } = await pair({ documentId: adminDoc, reviewerUserId: admin.userId })
    await expectRefusedAndUnchanged(mine.id, theirs.id)
  })

  it('is refused when a fact it would reject was confirmed by an admin', async () => {
    const { mine, theirs } = await pair({
      documentId: adminDoc,
      reviewerUserId: admin.userId,
      confirmedBy: admin.userId,
    })
    await expectRefusedAndUnchanged(mine.id, theirs.id)
  })

  it('is refused when a fact of their own was confirmed by another person', async () => {
    const { mine, theirs } = await pair({
      documentId: memberDoc,
      reviewerUserId: member.userId,
      confirmedBy: admin.userId,
    })
    await expectRefusedAndUnchanged(mine.id, theirs.id)
  })

  it('is refused when a fact it would reject has no reviewer', async () => {
    const { mine, theirs } = await pair({ documentId: adminDoc, reviewerUserId: null })
    await expectRefusedAndUnchanged(mine.id, theirs.id)
  })

  it('still rejects the other side when both are theirs to review', async () => {
    const { mine, theirs } = await pair({ documentId: memberDoc, reviewerUserId: member.userId })
    const res = await prefer(mine.id, member)
    expect(res.status).toBe(200)
    const body = factReviewResponseSchema.parse(await json(res))
    expect(body.fact).toMatchObject({ state: 'accepted', confirmedBy: member.userId })
    expect(body.affected.map(f => [f.id, f.state])).toEqual([[theirs.id, 'rejected']])
  })

  it('may still reject their own side of a conflict they cannot settle', async () => {
    const { mine, theirs } = await pair({
      documentId: adminDoc,
      reviewerUserId: admin.userId,
      confirmedBy: admin.userId,
    })
    const res = await request(
      `/api/knowledge/facts/${mine.id}/review`,
      { method: 'POST', headers: member.cookie },
      { env, json: { action: 'reject' } }
    )
    expect(res.status).toBe(200)
    expect((await rowOf(theirs.id))?.state).toBe('accepted')
  })
})

describe('prefer by an admin', () => {
  it('rejects a side another person reviews and confirmed', async () => {
    const { mine, theirs } = await pair({
      documentId: adminDoc,
      reviewerUserId: admin.userId,
      confirmedBy: admin.userId,
    })
    const res = await prefer(mine.id, admin)
    expect(res.status).toBe(200)
    expect((await rowOf(theirs.id))?.state).toBe('rejected')
    expect((await rowOf(mine.id))?.confirmedBy).toBe(admin.userId)
  })
})
