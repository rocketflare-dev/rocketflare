// @vitest-isolate
// Mocks the provider seam (`ai/resolve`) and the entity-type registry, so it needs its own registry.
/**
 * Extraction builds what it shows the models only from documents everyone who can read the new
 * document may also read: while one document's facts are read, the known entities, their accepted
 * facts, and the held facts a decision model compares are those of TENANT-VISIBLE documents. A
 * fact or a name read from a group-restricted document never reaches the prompt, so a model cannot
 * copy it into a document with a wider audience. And a group-restricted document adds no names to
 * an entity: the aliases on an entity card and behind the Facts view's name filter come from
 * documents every member can open.
 */
import { entityCardSchema } from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildAgentTools } from '@/api/services/agents/tools'
import { ingestText } from '@/api/services/ai/ingest'
import { setTenantOverride } from '@/api/services/features'
import { extractDocumentFacts, type FactCandidate } from '@/api/services/knowledge/extract'
import type {
  EntityQuestion,
  JudgeAnswer,
  KnowledgeJudge,
  ValueQuestion,
} from '@/api/services/knowledge/judge'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { loadConfig } from '@/config'
import { groupMembers, groups, groupTypes, knowledgeEntities } from '@/db/schema'
import { FakeChatClient } from '../../helpers/ai'
import {
  createTestSession,
  createTestTenant,
  createTestUser,
  linkUserToTenant,
  sessionCookieHeader,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { seedDocument, seedEntity, seedFact } from '../../helpers/knowledge-facts'
import { json, request } from '../../helpers/request'
import { createTestEnv, type TestEnv } from '../../mocks/bindings'

const state: { client: FakeChatClient | null; types: EntityTypeRegistration[] } = {
  client: null,
  types: [],
}

vi.mock('@/api/services/ai/resolve', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/ai/resolve')>()
  const { AiNotConfiguredError } = await import('@/api/services/ai/errors')
  return {
    ...actual,
    resolveChat: vi.fn(async () => {
      if (!state.client) throw new AiNotConfiguredError('chat')
      return {
        client: state.client,
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        source: 'tenant',
        billedToPlatform: false,
        maxOutputTokens: 4096,
      }
    }),
    resolveDecisions: vi.fn(async () => {
      throw new AiNotConfiguredError('chat')
    }),
  }
})

vi.mock('@/api/services/knowledge/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/services/knowledge/registry')>()
  return { ...actual, knowledgeEntityTypes: () => state.types }
})

const db = setupTestDatabase()

const customer: EntityTypeRegistration = {
  type: 'customer',
  label: 'Customer',
  facts: z.object({ monthly_fee_gbp: z.number().describe('Monthly fee in pounds') }),
}

let env: TestEnv
let cfg: ReturnType<typeof loadConfig>

beforeEach(() => {
  env = createTestEnv()
  cfg = loadConfig(env)
  state.client = null
  state.types = [customer]
})

/** A tenant with a group, a member in it, and a member outside it. */
async function world() {
  const tenantId = (await createTestTenant(db)).id
  const admin = await createTestUser(db)
  await linkUserToTenant(db, admin.id, tenantId, 'admin')
  await setTenantOverride(db, 'knowledge-facts', tenantId, true, admin.id)
  const insider = await createTestUser(db)
  await linkUserToTenant(db, insider.id, tenantId, 'member')
  const outsider = await createTestUser(db)
  await linkUserToTenant(db, outsider.id, tenantId, 'member')
  const [type] = await db.insert(groupTypes).values({ tenantId, name: 'Dept' }).returning()
  const [group] = await db
    .insert(groups)
    .values({ tenantId, groupTypeId: type?.id ?? '', name: 'Board' })
    .returning()
  const groupId = group?.id ?? ''
  await db.insert(groupMembers).values({ tenantId, groupId, userId: insider.id })
  return { tenantId, adminId: admin.id, insiderId: insider.id, outsiderId: outsider.id, groupId }
}

type World = Awaited<ReturnType<typeof world>>

async function addDoc(
  w: World,
  userId: string,
  title: string,
  text: string,
  restricted = false
): Promise<string> {
  const { document } = await ingestText(
    db,
    cfg,
    env,
    {
      tenantId: w.tenantId,
      userId,
      title,
      text,
      ...(restricted ? { visibility: 'groups' as const, groupIds: [w.groupId] } : {}),
    },
    { jobs: env.JOBS_QUEUE }
  )
  return document.id
}

/** The model answers every section with these candidates, and keeps every prompt it was sent. */
function model(facts: Partial<FactCandidate>[]) {
  state.client = new FakeChatClient(() => ({
    toolUses: [
      {
        name: 'submit_facts',
        input: {
          facts: facts.map(f => ({ entityType: 'customer', confidence: 0.95, ...f })),
        },
      },
    ],
  }))
  return state.client
}

const promptsOf = (client: FakeChatClient) => JSON.stringify(client.calls.map(c => c.messages))

const extract = (w: World, documentId: string, extra = {}) =>
  extractDocumentFacts(
    db,
    cfg,
    env,
    { tenantId: w.tenantId, documentId },
    { jobs: env.JOBS_QUEUE, ...extra }
  )

function scriptedJudge() {
  const asked = { values: [] as ValueQuestion[], entities: [] as EntityQuestion[] }
  const judge: KnowledgeJudge = {
    engine: async () => ({ method: 'llm_self_report', model: 'fake-judge' }),
    values: async qs => {
      asked.values.push(...qs)
      return qs.map((): JudgeAnswer<'same' | 'compatible'> => null)
    },
    entities: async qs => {
      asked.entities.push(...qs)
      return qs.map((): JudgeAnswer<string> => null)
    },
  }
  return { judge, asked }
}

describe('the extraction prompt is built from documents every reader of the new one can open', () => {
  it('a fact or a name from a restricted document is never in the prompt for a tenant-visible document', async () => {
    const w = await world()
    const restricted = await seedDocument(db, {
      tenantId: w.tenantId,
      title: 'Board minutes',
      ownerUserId: w.insiderId,
      groupIds: [w.groupId],
    })
    const open = await seedDocument(db, { tenantId: w.tenantId, title: 'Price list' })
    const bakery = await seedEntity(db, { tenantId: w.tenantId, name: 'Brightside Bakery' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: bakery.id,
      documentId: restricted.id,
      value: 987654,
    })
    const dental = await seedEntity(db, { tenantId: w.tenantId, name: 'Harbour View Dental' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: dental.id,
      documentId: open.id,
      value: 285,
    })
    const larkspur = await seedEntity(db, { tenantId: w.tenantId, name: 'Larkspur Holdings' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: larkspur.id,
      documentId: restricted.id,
      value: 5,
    })

    const note = await addDoc(
      w,
      w.outsiderId,
      'Note',
      '# Note\n\nBrightside Bakery and Harbour View Dental are customers of ours.'
    )
    const client = model([])
    await extract(w, note)
    const sent = promptsOf(client)
    expect(sent).toContain('monthly_fee_gbp = 285')
    expect(sent).not.toContain('987654')
    expect(sent).not.toContain('Larkspur Holdings')
  })

  it('a value only a restricted document holds never reaches a member outside it through a new document', async () => {
    const w = await world()
    const restricted = await seedDocument(db, {
      tenantId: w.tenantId,
      title: 'Board minutes',
      ownerUserId: w.insiderId,
      groupIds: [w.groupId],
    })
    const bakery = await seedEntity(db, { tenantId: w.tenantId, name: 'Brightside Bakery' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: bakery.id,
      documentId: restricted.id,
      value: 987654,
    })
    const note = await addDoc(
      w,
      w.outsiderId,
      'Note',
      '# Note\n\nBrightside Bakery is a customer of ours.'
    )
    // A model that repeats any accepted value it is shown for the entity.
    state.client = new FakeChatClient((params: { messages: { content: unknown }[] }) => {
      const shown = /monthly_fee_gbp = (\d+)/.exec(String(params.messages[0]?.content))
      return {
        toolUses: [
          {
            name: 'submit_facts',
            input: {
              facts: shown
                ? [
                    {
                      entityType: 'customer',
                      entityName: 'Brightside Bakery',
                      key: 'monthly_fee_gbp',
                      value: Number(shown[1]),
                      quote: 'Brightside Bakery is a customer of ours.',
                      confidence: 0.95,
                    },
                  ]
                : [],
            },
          },
        ],
      }
    })
    await extract(w, note)
    const tools = await buildAgentTools({
      db,
      cfg,
      env,
      scope: { tenantId: w.tenantId, userId: w.outsiderId, groupIds: [], bypass: false },
      features: ['knowledge-facts'],
    })
    const lookup = tools.find(t => t.name === 'lookup_facts')
    if (!lookup?.handler) throw new Error('no lookup_facts')
    const answer = await lookup.handler({ entity: 'Brightside Bakery' } as never)
    expect(answer).not.toContain('987654')
  })

  it('the decision model compares a new value only with values from tenant-visible documents', async () => {
    const w = await world()
    const restricted = await seedDocument(db, {
      tenantId: w.tenantId,
      title: 'Board minutes',
      groupIds: [w.groupId],
    })
    const open = await seedDocument(db, { tenantId: w.tenantId, title: 'Price list' })
    const bakery = await seedEntity(db, { tenantId: w.tenantId, name: 'Brightside Bakery' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: bakery.id,
      documentId: restricted.id,
      value: 987654,
    })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: bakery.id,
      documentId: open.id,
      value: 200,
    })
    const note = await addDoc(
      w,
      w.outsiderId,
      'Note',
      '# Note\n\nBrightside Bakery now pays £120 a month.'
    )
    model([
      {
        entityName: 'Brightside Bakery',
        key: 'monthly_fee_gbp',
        value: 120,
        quote: 'Brightside Bakery now pays £120 a month.',
      },
    ])
    const { judge, asked } = scriptedJudge()
    await extract(w, note, { judge })
    expect(asked.values.map(q => q.a.value)).toEqual(['200'])
  })

  it('the decision model is shown a nearby entity with its tenant-visible facts only', async () => {
    const w = await world()
    const restricted = await seedDocument(db, {
      tenantId: w.tenantId,
      title: 'Board minutes',
      groupIds: [w.groupId],
    })
    const open = await seedDocument(db, { tenantId: w.tenantId, title: 'Price list' })
    const dental = await seedEntity(db, { tenantId: w.tenantId, name: 'Harbour View Dental' })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: dental.id,
      documentId: open.id,
      value: 285,
    })
    await seedFact(db, {
      tenantId: w.tenantId,
      entityId: dental.id,
      documentId: restricted.id,
      key: 'visit_fee_gbp',
      value: 987654,
    })
    const note = await addDoc(
      w,
      w.outsiderId,
      'Note',
      '# Note\n\nHarbourside Dental Lab pays £120 a month.'
    )
    model([
      {
        entityName: 'Harbourside Dental Lab',
        key: 'monthly_fee_gbp',
        value: 120,
        quote: 'Harbourside Dental Lab pays £120 a month.',
      },
    ])
    const { judge, asked } = scriptedJudge()
    await extract(w, note, { judge })
    const candidate = asked.entities.flatMap(q => q.candidates).find(c => c.id === dental.id)
    expect(candidate?.facts).toEqual(['monthly_fee_gbp = 285'])
  })
})

describe('the names a restricted document reads stay with that document', () => {
  it('a restricted document adds no alias to an entity; a tenant-visible one still does', async () => {
    const w = await world()
    const open = await seedDocument(db, { tenantId: w.tenantId, title: 'Price list' })
    const acme = await seedEntity(db, { tenantId: w.tenantId, name: 'Acme Corp' })
    await seedFact(db, { tenantId: w.tenantId, entityId: acme.id, documentId: open.id, value: 100 })

    const memo = await addDoc(
      w,
      w.insiderId,
      'Restricted memo',
      '# Memo\n\nAcme Corp, known here as Project Falcon, pays £500 a month.',
      true
    )
    model([
      {
        entityName: 'Acme Corp',
        aliases: ['Project Falcon'],
        key: 'monthly_fee_gbp',
        value: 500,
        quote: 'Acme Corp, known here as Project Falcon, pays £500 a month.',
      },
    ])
    await extract(w, memo)

    const outsiderCookie = sessionCookieHeader(
      await createTestSession(db, w.outsiderId, w.tenantId)
    )
    const card = entityCardSchema.parse(
      await json(
        await request(
          `/api/knowledge/entities/customer/${acme.id}`,
          { headers: outsiderCookie },
          { env }
        )
      )
    )
    expect(card.entity.aliases).not.toContain('Project Falcon')
    const list = (await json(
      await request('/api/knowledge/entities?q=Falcon', { headers: outsiderCookie }, { env })
    )) as { items: { entity: { id: string } }[] }
    expect(list.items.map(i => i.entity.id)).not.toContain(acme.id)

    const note = await addDoc(
      w,
      w.outsiderId,
      'Note',
      '# Note\n\nAcme Corp, trading as Acme Northern, pays £100 a month.'
    )
    model([
      {
        entityName: 'Acme Corp',
        aliases: ['Acme Northern'],
        key: 'monthly_fee_gbp',
        value: 100,
        quote: 'Acme Corp, trading as Acme Northern, pays £100 a month.',
      },
    ])
    await extract(w, note)
    const [row] = await db
      .select({ aliases: knowledgeEntities.aliases })
      .from(knowledgeEntities)
      .where(and(eq(knowledgeEntities.tenantId, w.tenantId), eq(knowledgeEntities.id, acme.id)))
    expect(row?.aliases).toEqual(['Acme Northern'])
  })

  it('an entity first read from a restricted document carries its name only', async () => {
    const w = await world()
    const memo = await addDoc(
      w,
      w.insiderId,
      'Restricted memo',
      '# Memo\n\nWillow Farm, known here as Project Heron, pays £500 a month.',
      true
    )
    model([
      {
        entityName: 'Willow Farm',
        aliases: ['Project Heron'],
        key: 'monthly_fee_gbp',
        value: 500,
        quote: 'Willow Farm, known here as Project Heron, pays £500 a month.',
      },
    ])
    await extract(w, memo)
    const rows = await db
      .select({ name: knowledgeEntities.name, aliases: knowledgeEntities.aliases })
      .from(knowledgeEntities)
      .where(eq(knowledgeEntities.tenantId, w.tenantId))
    expect(rows).toEqual([{ name: 'Willow Farm', aliases: [] }])
  })
})
