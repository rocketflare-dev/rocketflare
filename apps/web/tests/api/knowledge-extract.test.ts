// @vitest-isolate
// Mocks the provider seam (`ai/resolve`) and the entity-type registry, so it needs its own registry.
/**
 * Knowledge-fact extraction (D43) against real Postgres, with a scripted `FakeChatClient` as the
 * model: when `knowledge.extract` is enqueued (flag, registered types, a text that changed — never
 * the unchanged upsert or a dedupe), the verifier, dates resolved against the document's date,
 * every row of the state table, validity → superseded, entity resolution (a registered resolver's
 * row, a staging entity, a possible match), tenant isolation, the daily cap's delayed re-enqueue,
 * re-extraction replacing a document's facts while a person's decisions on them survive, and the
 * `entity.changed { entity: 'knowledge' }` nudge a run sends. The pure halves are
 * `tests/config/knowledge-extraction.test.ts`.
 */

import { preferredFact } from '@rocketflare/shared/ai/knowledge-facts'
import type { JobEnvelope } from '@rocketflare/shared/jobs'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { handleDocumentIndex } from '@/api/queues/handlers/document-index'
import { handleKnowledgeExtract } from '@/api/queues/handlers/knowledge-extract'
import type { JobContext } from '@/api/queues/jobs'
import { ingestText } from '@/api/services/ai/ingest'
import { setTenantOverride } from '@/api/services/features'
import { buildJobEnvelope } from '@/api/services/jobs'
import { extractDocumentFacts, type FactCandidate } from '@/api/services/knowledge/extract'
import type { ReviewReader } from '@/api/services/knowledge/facts-read'
import { reviewFact } from '@/api/services/knowledge/review'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { collectingRealtime } from '@/api/services/realtime'
import { loadConfig } from '@/config'
import { aiUsage, documents, knowledgeEntities, knowledgeFacts } from '@/db/schema'
import { FakeChatClient } from '../helpers/ai'
import { createTestTenantWithUser } from '../helpers/auth'
import { setupTestDatabase } from '../helpers/db'
import { createTestEnv, stubs, type TestEnv } from '../mocks/bindings'

const state: {
  client: FakeChatClient | null
  types: EntityTypeRegistration[]
  resolved: { name: string; tenantId: string }[]
} = { client: null, types: [], resolved: [] }

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
  facts: z.object({
    monthly_fee_gbp: z.number().describe('Monthly fee in pounds'),
    visit_day: z.string().describe('Day of the routine visit'),
    contract_renewal_date: z.iso.date().describe('When the contract renews'),
    primary_contact: z.string().describe('Main contact person'),
  }),
}

/** A domain type whose rows come from a registered resolver (as a table-backed type would). */
const account: EntityTypeRegistration = {
  type: 'account',
  label: 'Account',
  facts: z.object({ monthly_fee_gbp: z.number() }),
  resolve: async (name, scope) => {
    state.resolved.push({ name, tenantId: scope.access.tenantId })
    return name.toLowerCase().includes('harbour view')
      ? [{ id: 'acct-42', label: 'Harbour View Dental', score: 0.95 }]
      : []
  },
}

function fakeLogger() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log }
  return log as unknown as JobContext['logger']
}

/** The model answers every section with these candidates. */
function model(...turns: Partial<FactCandidate>[][]) {
  state.client = new FakeChatClient(
    turns.map(facts => ({
      toolUses: [
        {
          name: 'submit_facts',
          input: {
            facts: facts.map(f => ({
              entityType: 'customer',
              entityName: 'Harbour View Dental',
              confidence: 0.95,
              ...f,
            })),
          },
        },
      ],
    }))
  )
  return state.client
}

let env: TestEnv
let cfg: ReturnType<typeof loadConfig>

beforeEach(() => {
  env = createTestEnv()
  cfg = loadConfig(env)
  state.client = null
  state.types = [customer, account]
  state.resolved = []
})

async function world(options: { flag?: boolean } = {}) {
  const { user, tenant } = await createTestTenantWithUser(db, 'owner')
  if (options.flag !== false) {
    await setTenantOverride(db, 'knowledge-facts', tenant.id, true, user.id)
  }
  return { tenantId: tenant.id, userId: user.id }
}

async function addDoc(
  w: { tenantId: string; userId: string },
  text: string,
  options: { date?: string; origin?: 'upload' | 'integration'; title?: string } = {}
) {
  const { document } = await ingestText(
    db,
    cfg,
    env,
    {
      tenantId: w.tenantId,
      userId: w.userId,
      title: options.title ?? 'A document',
      text,
      origin: options.origin,
    },
    { jobs: env.JOBS_QUEUE }
  )
  if (options.date) {
    const at = new Date(`${options.date}T09:00:00Z`)
    await db
      .update(documents)
      .set({ createdAt: at })
      .where(and(eq(documents.id, document.id), eq(documents.tenantId, w.tenantId)))
  }
  return document.id
}

const extract = (w: { tenantId: string }, documentId: string, extra = {}) =>
  extractDocumentFacts(
    db,
    cfg,
    env,
    { tenantId: w.tenantId, documentId },
    { jobs: env.JOBS_QUEUE, ...extra }
  )

const factsOf = (tenantId: string, documentId?: string) =>
  db
    .select()
    .from(knowledgeFacts)
    .where(
      documentId
        ? and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.documentId, documentId))
        : eq(knowledgeFacts.tenantId, tenantId)
    )

const extractMessages = (e: TestEnv) =>
  stubs(e).queue.messages.filter(m => (m.body as JobEnvelope).type === 'knowledge.extract')

const HVD = `# Harbour View Dental — maintenance contract

4.2 Monthly Fee: £285 per month, ex VAT.
Routine visits take place on Tuesdays.
This agreement renews on 31 January 2027.`

describe('enqueue: only for a changed text, with the flag and a registered type', () => {
  it('enqueues after an inline index when the tenant has the flag', async () => {
    const w = await world()
    const id = await addDoc(w, HVD)
    const [message] = extractMessages(env)
    expect(message?.body).toMatchObject({
      type: 'knowledge.extract',
      payload: { tenantId: w.tenantId, documentId: id },
    })
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, id) })
    const body = message?.body as (JobEnvelope & { payload: { contentHash?: string } }) | undefined
    expect(body?.payload.contentHash).toBe(doc?.contentHash)
  })

  it('does not enqueue with the flag off (the default) or with no entity types', async () => {
    const off = await world({ flag: false })
    await addDoc(off, HVD)
    expect(extractMessages(env)).toHaveLength(0)
    state.types = []
    const none = await world()
    await addDoc(none, `${HVD}\n\nno types`)
    expect(extractMessages(env)).toHaveLength(0)
  })

  it('does not enqueue for an unchanged upsert or a dedupe', async () => {
    const w = await world()
    const ingest = (text: string, source: string, externalId?: string) =>
      ingestText(
        db,
        cfg,
        env,
        { tenantId: w.tenantId, userId: w.userId, title: 't', text, source, externalId },
        { jobs: env.JOBS_QUEUE }
      )
    await ingest(HVD, 'crm', 'item-1')
    expect(extractMessages(env)).toHaveLength(1)
    const unchanged = await ingest(HVD, 'crm', 'item-1')
    expect(unchanged.mode).toBe('unchanged')
    expect(extractMessages(env)).toHaveLength(1)
    await ingest(HVD, 'paste') // a plain ingest: new text for this source…
    expect(extractMessages(env)).toHaveLength(2)
    const dup = await ingest(HVD, 'paste') // …and the same again is a dedupe
    expect(dup.deduplicated).toBe(true)
    expect(extractMessages(env)).toHaveLength(2)
    await ingest(`${HVD}\nChanged.`, 'crm', 'item-1')
    expect(extractMessages(env)).toHaveLength(3)
  })

  it('a queued index enqueues afterwards unless the producer said the text is unchanged', async () => {
    const w = await world()
    const id = await addDoc(w, HVD)
    stubs(env).queue.clear()
    const ctx: JobContext = { env, config: cfg, logger: fakeLogger(), db }
    await handleDocumentIndex(
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: w.tenantId, documentId: id, skipExtraction: true },
      }) as never,
      ctx
    )
    expect(extractMessages(env)).toHaveLength(0)
    await handleDocumentIndex(
      buildJobEnvelope({
        type: 'document.index',
        payload: { tenantId: w.tenantId, documentId: id },
      }) as never,
      ctx
    )
    expect(extractMessages(env)).toHaveLength(1)
  })

  it('the job re-checks the gates: flag off, no types, a changed text are skipped', async () => {
    const w = await world({ flag: false })
    const id = await addDoc(w, HVD)
    model([{ key: 'visit_day', value: 'Tuesday', quote: 'Routine visits take place on Tuesdays' }])
    expect(await extract(w, id)).toMatchObject({ status: 'skipped', reason: 'feature_off' })
    await setTenantOverride(db, 'knowledge-facts', w.tenantId, true, w.userId)
    state.types = []
    expect(await extract(w, id)).toMatchObject({ status: 'skipped', reason: 'no_entity_types' })
    state.types = [customer]
    const report = await extractDocumentFacts(db, cfg, env, {
      tenantId: w.tenantId,
      documentId: id,
      contentHash: 'not-the-current-hash',
    })
    expect(report).toMatchObject({ status: 'skipped', reason: 'content_changed' })
    expect(state.client?.calls ?? []).toHaveLength(0)
  })
})

describe('the pass: prompt, verifier, values, dates, provenance', () => {
  it('drops a quote that is not verbatim and stores the span of the one that is', async () => {
    const w = await world()
    const id = await addDoc(w, HVD, { date: '2026-02-03' })
    const client = model([
      { key: 'monthly_fee_gbp', value: '£285', quote: '4.2 Monthly Fee: £285 per month, ex VAT.' },
      { key: 'visit_day', value: 'Tuesday', quote: 'Visits are every Tuesday' },
    ])
    const report = await extract(w, id)
    expect(report).toMatchObject({
      status: 'extracted',
      candidates: 2,
      dropped: { quote_not_found: 1 },
    })
    const [fact] = await factsOf(w.tenantId, id)
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, id) })
    expect(fact).toMatchObject({
      key: 'monthly_fee_gbp',
      value: 285,
      valueText: '285',
      state: 'accepted',
      sourceKind: 'upload',
    })
    expect(doc?.content?.slice(fact?.charStart ?? 0, fact?.charEnd ?? 0)).toBe(fact?.quote)
    expect(fact?.chunkId).not.toBeNull()
    expect(fact?.observedAt.toISOString()).toBe('2026-02-03T09:00:00.000Z')
    // The prompt: the registered prompt key, the types' schemas with descriptions, the doc date.
    const call = client.calls[0]
    expect(call?.toolChoice).toEqual({ type: 'tool', name: 'submit_facts' })
    const user = JSON.stringify(call?.messages)
    expect(user).toContain('monthly_fee_gbp')
    expect(user).toContain('Monthly fee in pounds')
    expect(user).toContain('2026-02-03 (Tuesday)')
    // Metered as knowledge.extraction.
    const usage = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, w.tenantId))
    expect(usage.map(u => u.feature)).toContain('knowledge.extraction')
  })

  it('resolves dates in code against the document date; an unreadable one drops the fact', async () => {
    const w = await world()
    const id = await addDoc(w, `${HVD}\nFiona Marsh is the contact from next Monday.`, {
      date: '2026-05-18',
    })
    model([
      {
        key: 'contract_renewal_date',
        value: '31 January 2027',
        quote: 'This agreement renews on 31 January 2027.',
      },
      {
        key: 'primary_contact',
        value: 'Fiona Marsh',
        validFrom: 'next Monday',
        quote: 'Fiona Marsh is the contact from next Monday.',
      },
      {
        key: 'visit_day',
        value: 'Tuesday',
        validFrom: 'when the builders leave',
        quote: 'Routine visits take place on Tuesdays.',
      },
    ])
    const report = await extract(w, id)
    expect(report.dropped).toEqual({ bad_date: 1 })
    const facts = await factsOf(w.tenantId, id)
    expect(facts.find(f => f.key === 'contract_renewal_date')?.value).toBe('2027-01-31')
    expect(facts.find(f => f.key === 'primary_contact')?.validFrom?.toISOString()).toBe(
      '2026-05-25T00:00:00.000Z'
    )
  })

  it('takes trust and the reviewer from the document: an integration names its reviewer', async () => {
    const w = await world()
    const { user: connector } = await createTestTenantWithUser(db, 'owner')
    const { document } = await ingestText(
      db,
      cfg,
      env,
      {
        tenantId: w.tenantId,
        userId: null,
        title: 'Synced',
        text: HVD,
        origin: 'integration',
        reviewerUserId: connector.id,
      },
      { jobs: env.JOBS_QUEUE }
    )
    model([
      { key: 'monthly_fee_gbp', value: 285, confidence: 0.4, quote: 'Monthly Fee: £285 per month' },
    ])
    await extract(w, document.id)
    const [fact] = await factsOf(w.tenantId, document.id)
    expect(fact).toMatchObject({
      sourceKind: 'integration',
      state: 'unconfirmed',
      reviewerUserId: connector.id,
    })
  })
})

describe('state against what is held', () => {
  it('same value corroborates (and confirms an unconfirmed one); a different value conflicts', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, confidence: 0.5, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    expect((await factsOf(w.tenantId, a))[0]?.state).toBe('unconfirmed')

    const b = await addDoc(w, `${HVD}\nAgain: £285 per month.`, { date: '2026-03-01' })
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Again: £285 per month.' }])
    await extract(w, b)
    expect((await factsOf(w.tenantId, a))[0]?.state).toBe('accepted')
    expect((await factsOf(w.tenantId, b))[0]?.state).toBe('accepted')

    const c = await addDoc(w, 'Re: HVD direct debit — Harbour View Dental now pay £310 a month.', {
      date: '2026-06-10',
      origin: 'integration',
    })
    model([{ key: 'monthly_fee_gbp', value: 310, quote: 'now pay £310 a month' }])
    await extract(w, c)
    const all = await factsOf(w.tenantId)
    const newer = all.find(f => f.documentId === c)
    expect(newer?.state).toBe('conflicting')
    expect(new Set(newer?.conflictsWith)).toEqual(
      new Set(all.filter(f => f.documentId !== c).map(f => f.id))
    )
    for (const f of all.filter(f => f.documentId !== c)) {
      expect(f.state).toBe('conflicting')
      expect(f.conflictsWith).toContain(newer?.id)
    }
    // The integration is newest but LESS trusted: the newest upload stays preferred in answers.
    expect(preferredFact(all)?.documentId).toBe(b)
    // All three are about one staging entity.
    expect(new Set(all.map(f => f.entityId)).size).toBe(1)
  })

  it('a newer, as-trusted source is preferred', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    const b = await addDoc(w, 'Harbour View Dental: the fee is now £300 a month.', {
      date: '2026-06-01',
    })
    model([{ key: 'monthly_fee_gbp', value: 300, quote: 'the fee is now £300 a month' }])
    await extract(w, b)
    const all = await factsOf(w.tenantId)
    expect(all.every(f => f.state === 'conflicting')).toBe(true)
    expect(preferredFact(all)?.documentId).toBe(b)
  })

  it('disjoint validity windows are a change over time: the earlier is superseded', async () => {
    const w = await world()
    const a = await addDoc(w, 'Harbour View Dental contact: Helen until 10 July 2026.', {
      date: '2026-06-01',
    })
    model([
      {
        key: 'primary_contact',
        value: 'Helen',
        validTo: '10 July 2026',
        quote: 'contact: Helen until 10 July 2026',
      },
    ])
    await extract(w, a)
    const b = await addDoc(w, 'Harbour View Dental: Raj is the contact from 13 July 2026.', {
      date: '2026-07-08',
    })
    model([
      {
        key: 'primary_contact',
        value: 'Raj',
        validFrom: '13 July 2026',
        quote: 'Raj is the contact from 13 July 2026',
      },
    ])
    await extract(w, b)
    const [helen] = await factsOf(w.tenantId, a)
    const [raj] = await factsOf(w.tenantId, b)
    expect(raj).toMatchObject({ state: 'accepted', conflictsWith: [] })
    expect(helen).toMatchObject({ state: 'superseded', supersededById: raj?.id })
  })
  it('two values for one key over one window in one section are a misreading: neither is written', async () => {
    const w = await world()
    const id = await addDoc(
      w,
      'Harbour View Dental — | Monthly fee | £285 | Call-out | £85 |. Contact Helen until 10 July 2026, Raj from 13 July 2026.',
      { date: '2026-06-01' }
    )
    model([
      { key: 'monthly_fee_gbp', value: '£285', quote: '| Monthly fee | £285 |' },
      { key: 'monthly_fee_gbp', value: '£85', quote: '| Call-out | £85 |' },
      // Different windows in one section: a change over time, both kept.
      {
        key: 'primary_contact',
        value: 'Helen',
        validTo: '10 July 2026',
        quote: 'Helen until 10 July 2026',
      },
      {
        key: 'primary_contact',
        value: 'Raj',
        validFrom: '13 July 2026',
        quote: 'Raj from 13 July 2026',
      },
    ])
    const report = await extract(w, id)
    expect(report.dropped).toEqual({ ambiguous: 2 })
    const facts = await factsOf(w.tenantId, id)
    expect(facts.map(f => `${f.key}=${f.valueText}`).sort()).toEqual([
      'primary_contact=Helen',
      'primary_contact=Raj',
    ])
  })
})

describe('entity resolution', () => {
  it('links to a registered resolver’s row, in the extracting tenant', async () => {
    const w = await world()
    const id = await addDoc(w, HVD)
    model([
      { entityType: 'account', key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' },
    ])
    await extract(w, id)
    const [fact] = await factsOf(w.tenantId, id)
    expect(fact).toMatchObject({ entityKind: 'domain', entityType: 'account', entityId: 'acct-42' })
    expect(state.resolved.every(r => r.tenantId === w.tenantId)).toBe(true)
  })

  it('links a fuller name to a staging entity (as an alias); a near twin becomes a possible match', async () => {
    const w = await world()
    const a = await addDoc(w, HVD)
    model([
      {
        key: 'visit_day',
        value: 'Tuesday',
        aliases: ['HVD'],
        quote: 'Routine visits take place on Tuesdays.',
      },
    ])
    await extract(w, a)
    const b = await addDoc(
      w,
      'Harbour View Dental Practice Ltd — visits on Tuesdays. Harbourside Dental Lab — Thursdays.'
    )
    model([
      {
        entityName: 'Harbour View Dental Practice Ltd',
        key: 'visit_day',
        value: 'Tuesday',
        quote: 'visits on Tuesdays',
      },
      {
        entityName: 'Harbourside Dental Lab',
        key: 'visit_day',
        value: 'Thursday',
        quote: 'Harbourside Dental Lab — Thursdays',
      },
    ])
    const report = await extract(w, b)
    expect(report).toMatchObject({ entitiesCreated: 1, possibleMatches: 1 })
    const entities = await db
      .select()
      .from(knowledgeEntities)
      .where(eq(knowledgeEntities.tenantId, w.tenantId))
    const hvd = entities.find(e => e.name === 'Harbour View Dental')
    expect(hvd?.aliases).toEqual(
      expect.arrayContaining(['HVD', 'Harbour View Dental Practice Ltd'])
    )
    const twin = entities.find(e => e.name === 'Harbourside Dental Lab')
    expect(twin?.possibleMatches?.map(c => c.id)).toEqual([hvd?.id])
    expect(twin?.reviewerUserId).toBe(w.userId)
    // The twin's fact is on the twin, so it does not conflict with HVD's Tuesday.
    const facts = await factsOf(w.tenantId)
    expect(facts.every(f => f.state === 'accepted')).toBe(true)
  })

  it('never resolves across tenants', async () => {
    const other = await world()
    const o = await addDoc(other, HVD)
    model([{ key: 'monthly_fee_gbp', value: 999, quote: 'Monthly Fee: £285' }])
    // A fact the OTHER tenant holds (value deliberately different).
    await extract(other, o)
    const w = await world()
    const id = await addDoc(w, HVD)
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    const report = await extract(w, id)
    expect(report.entitiesCreated).toBe(1)
    const [mine] = await factsOf(w.tenantId, id)
    const [theirs] = await factsOf(other.tenantId, o)
    expect(mine?.state).toBe('accepted')
    expect(mine?.entityId).not.toBe(theirs?.entityId)
    expect(theirs?.state).toBe('accepted')
  })
})

describe('cost, retries and re-extraction', () => {
  it('at the daily cap the job re-enqueues itself for the next UTC day and does nothing else', async () => {
    const capped = createTestEnv({ KNOWLEDGE_TENANT_DAILY_COST_USD: '0.01' } as never)
    const cappedCfg = loadConfig(capped)
    const w = await world()
    const id = await addDoc(w, HVD)
    await db.insert(aiUsage).values({
      tenantId: w.tenantId,
      feature: 'knowledge.extraction',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      inputTokens: 1,
      outputTokens: 1,
      costMicrocents: 5_000_000, // $0.05
    })
    const client = model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    const ctx: JobContext = { env: capped, config: cappedCfg, logger: fakeLogger(), db }
    await handleKnowledgeExtract(
      buildJobEnvelope({
        type: 'knowledge.extract',
        payload: { tenantId: w.tenantId, documentId: id },
      }) as never,
      ctx
    )
    const [again] = extractMessages(capped)
    expect(again?.body).toMatchObject({ payload: { tenantId: w.tenantId, documentId: id } })
    const delay = (again?.options as { delaySeconds?: number } | undefined)?.delaySeconds ?? 0
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(12 * 3600)
    expect(client.calls).toHaveLength(0)
    expect(await factsOf(w.tenantId, id)).toHaveLength(0)
  })

  it('re-extracting a document replaces its facts and undoes the conflicts they caused', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    const b = await addDoc(w, 'Harbour View Dental now pay £310 a month.', { date: '2026-06-10' })
    model([{ key: 'monthly_fee_gbp', value: 310, quote: 'now pay £310 a month' }])
    await extract(w, b)
    expect((await factsOf(w.tenantId, a))[0]?.state).toBe('conflicting')
    // B is extracted again and this time the model reads no fee from it.
    model([{ key: 'visit_day', value: 'Tuesday', quote: 'Harbour View Dental now pay' }])
    const report = await extract(w, b)
    expect(report.replaced).toBe(1)
    const [onlyB] = await factsOf(w.tenantId, b)
    expect(onlyB?.key).toBe('visit_day')
    expect((await factsOf(w.tenantId, a))[0]).toMatchObject({
      state: 'accepted',
      conflictsWith: [],
    })
  })

  it('a model that never answers validly skips the section, not the document', async () => {
    const w = await world()
    const id = await addDoc(w, HVD)
    state.client = new FakeChatClient([{ text: 'no tool call' }])
    const report = await extract(w, id)
    expect(report).toMatchObject({ status: 'extracted', failedSections: 1 })
    expect(state.client.calls).toHaveLength(2) // callStructuredTool's one retry
  })
})

describe('a person’s decision survives re-extracting its own document', () => {
  const reader = (w: { tenantId: string; userId: string }): ReviewReader => ({
    scope: { tenantId: w.tenantId, userId: w.userId, groupIds: [], bypass: true },
    userId: w.userId,
    canManage: true,
  })

  it('a confirmed fact read again keeps its row, its confirmation and a fresh citation', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, confidence: 0.5, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    const [before] = await factsOf(w.tenantId, a)
    expect(before?.state).toBe('unconfirmed')
    await reviewFact(db, reader(w), before?.id ?? '', 'confirm')
    const confirmedAt = (await factsOf(w.tenantId, a))[0]?.confirmedAt

    model([{ key: 'monthly_fee_gbp', value: 285, confidence: 0.4, quote: '£285 per month' }])
    const report = await extract(w, a)
    expect(report).toMatchObject({ decisionsKept: 1, replaced: 0, factIds: [before?.id] })
    const [after] = await factsOf(w.tenantId, a)
    expect(after).toMatchObject({
      id: before?.id,
      state: 'accepted',
      confirmedBy: w.userId,
      quote: '£285 per month',
      confidence: 0.4,
    })
    expect(confirmedAt).toBeInstanceOf(Date)
    expect(after?.confirmedAt?.getTime()).toBe(confirmedAt?.getTime())
  })

  it('a prefer survives re-reading either side: the loser stays rejected, the winner confirmed', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    const fee285 = { key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }
    model([fee285])
    await extract(w, a)
    const b = await addDoc(w, 'Harbour View Dental now pay £310 a month.', { date: '2026-06-10' })
    const fee310 = { key: 'monthly_fee_gbp', value: 310, quote: 'now pay £310 a month' }
    model([fee310])
    await extract(w, b)
    const [winner] = await factsOf(w.tenantId, b)
    await reviewFact(db, reader(w), winner?.id ?? '', 'prefer')
    expect((await factsOf(w.tenantId, a))[0]?.state).toBe('rejected')

    // The loser's document again: without the carry-over it would come back `conflicting`.
    model([fee285])
    expect((await extract(w, a)).decisionsKept).toBe(1)
    // …and the winner's: still confirmed, no new conflict with the rejected side.
    model([fee310])
    expect((await extract(w, b)).decisionsKept).toBe(1)
    const [loser] = await factsOf(w.tenantId, a)
    const [kept] = await factsOf(w.tenantId, b)
    expect(loser).toMatchObject({ state: 'rejected', conflictsWith: [] })
    expect(kept).toMatchObject({
      id: winner?.id,
      state: 'accepted',
      confirmedBy: w.userId,
      conflictsWith: [],
    })
  })

  it('a decided fact the new text no longer states is deleted with the rest', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, confidence: 0.5, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    const [fact] = await factsOf(w.tenantId, a)
    await reviewFact(db, reader(w), fact?.id ?? '', 'reject')
    model([{ key: 'visit_day', value: 'Tuesday', quote: 'Routine visits take place on Tuesdays' }])
    const report = await extract(w, a)
    expect(report).toMatchObject({ decisionsKept: 0, replaced: 1 })
    const facts = await factsOf(w.tenantId, a)
    expect(facts.map(f => f.key)).toEqual(['visit_day'])
  })

  it('keeps a decided fact when a section failed: an incomplete reading is no evidence', async () => {
    const w = await world()
    const a = await addDoc(w, HVD, { date: '2026-02-03' })
    model([{ key: 'monthly_fee_gbp', value: 285, confidence: 0.5, quote: 'Monthly Fee: £285' }])
    await extract(w, a)
    const [fact] = await factsOf(w.tenantId, a)
    await reviewFact(db, reader(w), fact?.id ?? '', 'confirm')
    state.client = new FakeChatClient([{ text: 'no tool call' }])
    const report = await extract(w, a)
    expect(report).toMatchObject({ failedSections: 1, replaced: 0, decisionsKept: 0 })
    expect(await factsOf(w.tenantId, a)).toEqual([
      expect.objectContaining({ id: fact?.id, state: 'accepted', confirmedBy: w.userId }),
    ])
  })
})

describe('the nudge', () => {
  const knowledgeNudges = (tenantId: string) =>
    stubs(env)
      .hub.broadcasts.filter(b => b.tenantId === tenantId)
      .map(b => b.args[1] as { type: string; payload?: unknown })

  it('a run that wrote facts nudges entity.changed { entity: knowledge } once, after it is done', async () => {
    const w = await world()
    const a = await addDoc(w, HVD)
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    const realtime = collectingRealtime(env)
    await extract(w, a, { realtime })
    await realtime.flush()
    expect(knowledgeNudges(w.tenantId)).toEqual([
      expect.objectContaining({ type: 'entity.changed', payload: { entity: 'knowledge' } }),
    ])
  })

  it('a run that wrote and removed nothing sends none', async () => {
    const w = await world()
    const a = await addDoc(w, HVD)
    model([])
    const realtime = collectingRealtime(env)
    await extract(w, a, { realtime })
    await realtime.flush()
    expect(knowledgeNudges(w.tenantId)).toEqual([])
  })

  it('the job handler sends it before it returns', async () => {
    const w = await world()
    const a = await addDoc(w, HVD)
    model([{ key: 'monthly_fee_gbp', value: 285, quote: 'Monthly Fee: £285' }])
    const job = buildJobEnvelope({
      type: 'knowledge.extract',
      payload: { tenantId: w.tenantId, documentId: a },
    })
    await handleKnowledgeExtract(job as never, { env, config: cfg, logger: fakeLogger(), db })
    expect(knowledgeNudges(w.tenantId)).toHaveLength(1)
  })
})
