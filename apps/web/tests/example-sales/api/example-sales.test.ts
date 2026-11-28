/**
 * The example sales domain over the real app: a lead cannot go to someone HR says is on leave
 * (a call through `example-hr`'s `public.ts`), HR's approval event hands that person's leads back
 * (an event, no import), the qualify agent reads both domains' tools in one run, and nothing
 * crosses an organisation. Flags are per-tenant overrides, so no other file sees them.
 */
import { EXAMPLE_HR_FLAG, EXAMPLE_LEAVE_APPROVED_EVENT } from '@rocketflare/shared/example-hr/index'
import {
  EXAMPLE_QUALIFY_LEAD_AGENT,
  EXAMPLE_SALES_FLAG,
} from '@rocketflare/shared/example-sales/index'
import {
  createTestEnv,
  createTestSession,
  createTestTenant,
  createTestUser,
  deliverEvents,
  json,
  linkUserToTenant,
  request,
  runAgent,
  sessionCookieHeader,
  setupTestDatabase,
} from '@testkit/integration'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { allTables } from '@/plugins/api/peers'

const db = setupTestDatabase()
const today = new Date().toISOString().slice(0, 10)

interface Org {
  tenantId: string
  ownerId: string
  memberId: string
  owner: Record<string, string>
  member: Record<string, string>
}

async function flagsOn(tenantId: string) {
  const { featureFlags, tenantFeatureOverrides } = allTables()
  for (const key of [EXAMPLE_HR_FLAG, EXAMPLE_SALES_FLAG]) {
    await db.insert(featureFlags).values({ key, state: 'off' }).onConflictDoNothing()
    await db
      .insert(tenantFeatureOverrides)
      .values({ tenantId, flagKey: key, enabled: true })
      .onConflictDoNothing()
  }
}

async function org(): Promise<Org> {
  const tenantId = (await createTestTenant(db)).id
  const owner = await createTestUser(db)
  await linkUserToTenant(db, owner.id, tenantId, 'owner')
  const member = await createTestUser(db)
  await linkUserToTenant(db, member.id, tenantId, 'member')
  await flagsOn(tenantId)
  return {
    tenantId,
    ownerId: owner.id,
    memberId: member.id,
    owner: sessionCookieHeader(await createTestSession(db, owner.id, tenantId)),
    member: sessionCookieHeader(await createTestSession(db, member.id, tenantId)),
  }
}

const post = (
  path: string,
  headers: Record<string, string>,
  body: unknown,
  env = createTestEnv()
) => request(path, { method: 'POST', headers }, { env, json: body })

async function newLead(o: Org, body: Record<string, string>) {
  const res = await post('/api/example-sales/leads', o.member, body)
  expect(res.status).toBe(201)
  return json<{ id: string; ownerUserId: string | null }>(res)
}

/** The member asks for leave today; the owner approves it. Returns the approval's env. */
async function memberOnLeave(o: Org) {
  const asked = await post('/api/example-hr/leave-requests', o.member, {
    startsOn: today,
    endsOn: today,
    reason: 'Dentist',
  })
  expect(asked.status).toBe(201)
  const { id } = await json<{ id: string }>(asked)
  const env = createTestEnv()
  const approved = await post(
    `/api/example-hr/leave-requests/${id}/decision`,
    o.owner,
    { decision: 'approve' },
    env
  )
  expect(approved.status).toBe(200)
  return env
}

let a: Org
let b: Org
beforeAll(async () => {
  a = await org()
  b = await org()
})

describe('assigning a lead', () => {
  it('assigns to someone at work, and refuses someone HR has on leave today', async () => {
    const o = await org()
    const lead = await newLead(o, { name: 'Ada', company: 'Analytical' })
    const ok = await post(`/api/example-sales/leads/${lead.id}/assign`, o.owner, {
      ownerUserId: o.memberId,
    })
    expect(ok.status).toBe(200)
    await memberOnLeave(o)
    const other = await newLead(o, { name: 'Grace', company: 'Cobol' })
    const refused = await post(`/api/example-sales/leads/${other.id}/assign`, o.owner, {
      ownerUserId: o.memberId,
    })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({ code: 'example_sales_owner_on_leave' })
  })
})

describe('HR’s approval event', () => {
  it('hands the person’s leads back to the pool, once, on redelivery too', async () => {
    const o = await org()
    const lead = await newLead(o, { name: 'Linus', company: 'Kernel' })
    await post(`/api/example-sales/leads/${lead.id}/assign`, o.owner, { ownerUserId: o.memberId })
    const env = await memberOnLeave(o)
    const deliveries = await deliverEvents(env, db)
    expect(deliveries.map(d => [d.subscriber, d.outcome])).toContainEqual([
      'handler:example-sales:release-leads',
      'ack',
    ])
    const { pluginEvents } = allTables()
    const events = await db
      .select()
      .from(pluginEvents)
      .where(
        and(
          eq(pluginEvents.tenantId, o.tenantId),
          eq(pluginEvents.name, EXAMPLE_LEAVE_APPROVED_EVENT)
        )
      )
    expect(events).toHaveLength(1)
    const list = await json<{ items: Array<{ id: string; ownerUserId: string | null }> }>(
      await request('/api/example-sales/leads', { headers: o.owner })
    )
    expect(list.items.find(l => l.id === lead.id)?.ownerUserId).toBeNull()
  })
})

describe('the qualify agent', () => {
  it('reads the lead with sales’ tool and the owner’s leave with HR’s, in one run', async () => {
    const o = await org()
    const lead = await newLead(o, {
      name: 'Margaret',
      company: 'Apollo',
      notes: 'Wants a guidance computer by spring',
    })
    await post(`/api/example-sales/leads/${lead.id}/assign`, o.owner, { ownerUserId: o.memberId })
    await memberOnLeave(o)
    const { outcome, run } = await runAgent(createTestEnv(), db, {
      tenantId: o.tenantId,
      agentKey: EXAMPLE_QUALIFY_LEAD_AGENT,
      input: { leadId: lead.id },
      userId: o.ownerId,
    })
    expect(outcome.status).toBe('succeeded')
    expect(run.output).toMatchObject({
      leadId: lead.id,
      ownerOnLeave: true,
      status: 'qualified',
      score: 80,
    })
  })

  it('fails rather than guessing for a system run, which may read neither domain', async () => {
    // A run for nobody has no member grants, so neither tool is offered — the agent fails
    // instead of scoring a lead it could not read or calling an owner "available".
    const lead = await newLead(a, { name: 'Edsger', company: 'Structured' })
    const { outcome, run } = await runAgent(createTestEnv(), db, {
      tenantId: a.tenantId,
      agentKey: EXAMPLE_QUALIFY_LEAD_AGENT,
      input: { leadId: lead.id },
      userId: null,
    })
    expect(outcome.status).toBe('failed')
    expect(JSON.stringify(run)).toContain('is not available to this run')
  })
})

describe('tenant isolation', () => {
  it('never lets one organisation list, assign or qualify another’s lead', async () => {
    const lead = await newLead(a, { name: 'Barbara', company: 'Liskov' })
    const list = await json<{ items: Array<{ id: string }> }>(
      await request('/api/example-sales/leads', { headers: b.owner })
    )
    expect(list.items.map(l => l.id)).not.toContain(lead.id)
    const assign = await post(`/api/example-sales/leads/${lead.id}/assign`, b.owner, {
      ownerUserId: b.memberId,
    })
    expect(assign.status).toBe(404)
    const { outcome } = await runAgent(createTestEnv(), db, {
      tenantId: b.tenantId,
      agentKey: EXAMPLE_QUALIFY_LEAD_AGENT,
      input: { leadId: lead.id },
      userId: b.ownerId,
    })
    expect(outcome.status).toBe('failed')
  })
})
