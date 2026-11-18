/**
 * The facts target (D43): every document of a corpus with a `facts.jsonl`, extracted IN DATE ORDER
 * through the app's own job body (`extractDocumentFacts`) in one shared tenant — so each document
 * meets the facts the earlier ones left, the way a tenant's knowledge base grows — then scored
 * against the answer keys with the kit's scorers.
 *
 * The corpus's entity types are registered HERE (`corpusEntityTypes`), handed to the job body as its
 * `types` override, never added to the app's registry. They are staging-only (no table), built from
 * the key vocabulary the corpus README documents, each key with a `.describe()` that says what the
 * value means — the same thing an app writes for its own types.
 *
 * - **Per document** (`FactExtraction`): the stored facts of that document, mapped to `{ entityType,
 *   entity: <staging entity name>, key, value, doc }`, against its planted facts — precision, recall,
 *   F1 (`factExtractionScore`; names resolve through `entityIndex`, so an alias the extractor used
 *   still matches).
 * - **The whole corpus** (`facts-all`): the same scores over every document at once — the numbers
 *   the plan's exit reads.
 * - **Conflicts** (`conflicts`): the pairs the system flagged, mapped through ONE corpus-wide
 *   `matchFacts` to planted ids. A flag is a `conflicts_with` link, or a `superseded_by_id` link
 *   between two DIFFERENT documents — the answer key's "conflict" is "two sources give one entity
 *   and key different values", which the system answers either as a disagreement (both
 *   `conflicting`) or, when both windows are explicit and disjoint, as a change over time (the older
 *   `superseded`); a supersession inside one document is sequential validity, not a disagreement.
 *   A flag on a fact that matched nothing is a false alarm (`conflictDetectionScore`). `Winner`:
 *   for each planted conflict caught, does the side the system prefers (`preferredFact` for a
 *   conflict, the superseding fact for a supersession) equal the planted `winner`?
 */
import {
  type EntityFactsSchema,
  isPreferredOver,
  type SourceKind,
} from '@rocketflare/shared/ai/knowledge-facts'
import { estimateCostMicrocents } from '@rocketflare/shared/ai/pricing'
import { and, eq, inArray } from 'drizzle-orm'
import {
  createHarness,
  type Harness,
  type JsonValue,
  type Judge,
  type JudgeContext,
} from 'vitest-evals'
import { z } from 'zod'
import { withEvalScope } from '@/api/observability/context'
import { setTenantOverride } from '@/api/services/features'
import { type ExtractionReport, extractDocumentFacts } from '@/api/services/knowledge/extract'
import type { EntityTypeRegistration } from '@/api/services/knowledge/types'
import { getPrompt } from '@/api/services/prompts'
import { knowledgeEntities, knowledgeFacts, tenants } from '@/db/schema'
import type { Corpus } from './corpus'
import { EVAL_PROVIDER } from './env'
import { corpusWorld } from './fixtures'
import {
  conflictDetectionScore,
  entityIndex,
  type FactClaim,
  factExtractionScore,
  matchFacts,
  normalizeName,
} from './scoring'
import { promptHash } from './spend'

// ── The corpus's entity types ─────────────────────────────────────────────────────────────────

const PLANS = ['Essential', 'Standard', 'Premium'] as const
/** The price units Brightside charges by (README, "Answer keys"). */
const UNITS = [
  'per visit',
  'per site',
  'per site per year',
  'per tonne',
  'per bed per season',
  'per hour',
  'per month',
] as const
const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

const contact = z
  .string()
  .describe(
    'The named PERSON at this organisation who is the main contact — the name without a title (no Dr, Mr, Mrs), never a role or a department'
  )
const email = z
  .email()
  .describe('The email address of that contact (or the general address the document gives)')
const paymentTerms = z
  .number()
  .int()
  .describe(
    'How many days an invoice is payable within ("net 30", "within 30 days of invoice") — a number of days'
  )

/**
 * The kit fixture's vocabulary as staging-only types (no table: every entity is a staging one).
 * A copy evaluating its own corpus would register its own; these are what the Brightside README
 * documents, nothing more.
 */
export function corpusEntityTypes(): EntityTypeRegistration[] {
  const customer: EntityFactsSchema = z.object({
    primary_contact: contact,
    contact_email: email,
    contact_phone: z.string().describe("The customer contact's phone number, as written"),
    site_address: z.string().describe('The postal address of the customer site that is serviced'),
    service_plan: z.enum(PLANS).describe('The service plan the customer is on'),
    monthly_fee_gbp: z
      .number()
      .describe(
        'The fixed fee PER MONTH in pounds (ex VAT) — never a quarterly, annual or one-off amount'
      ),
    payment_terms_days: paymentTerms,
    contract_renewal_date: z.iso
      .date()
      .describe('The date the contract renews (or is due for renewal)'),
    account_manager: z
      .string()
      .describe(
        "The person at OUR company (the knowledge base's own business) named as managing or looking after this customer's account — not whoever an email is addressed to, or who handles its invoices"
      ),
    visit_day: z.enum(WEEKDAYS).describe('The weekday the routine maintenance visit happens'),
    gritting_included: z
      .boolean()
      .describe('Whether winter gritting is included for this customer'),
  })
  const supplier: EntityFactsSchema = z.object({
    primary_contact: contact,
    contact_email: email,
    account_number: z.string().describe('Our account / customer number with this supplier'),
    lead_time_days: z
      .number()
      .describe('How many days a delivery takes after ordering (working days count as days)'),
    payment_terms_days: paymentTerms,
    minimum_order_gbp: z.number().describe('The minimum order value in pounds (ex VAT)'),
  })
  const service: EntityFactsSchema = z.object({
    price_gbp: z
      .number()
      .describe(
        'The price in pounds of ONE unit of this service, as the price list or catalogue gives it'
      ),
    // A closed list, the way a business's own price units are: two wordings of one unit ("per
    // call-out", "per visit") are mapped to one member while the passage is in front of the model,
    // rather than compared as strings afterwards.
    unit: z
      .enum(UNITS)
      .describe(
        'What the price is per. A call-out, a single visit or an attendance is "per visit"; a price for a site for the whole year or season is "per site per year"'
      ),
    included_in_plans: z
      .array(z.enum(PLANS))
      .describe('The service plans that include this service at no extra charge'),
  })
  // People are entities too, so a contact or an account manager named two ways ("Marcus",
  // "Marcus Bell") resolves to one person. The answer key plants no person facts: they are not
  // scored (`SCORED_TYPES`).
  const person: EntityFactsSchema = z.object({
    job_title: z.string().describe("The person's job title or role, as the document gives it"),
  })
  return [
    {
      type: 'customer',
      label: 'Customer',
      facts: customer,
      refs: { primary_contact: 'person', account_manager: 'person' },
    },
    { type: 'supplier', label: 'Supplier', facts: supplier, refs: { primary_contact: 'person' } },
    { type: 'service', label: 'Service (something the business sells)', facts: service },
    { type: 'person', label: 'Person', facts: person },
  ]
}

// ── One extraction run per corpus ─────────────────────────────────────────────────────────────

export interface StoredFact extends FactClaim {
  factId: string
  documentId: string
  state: string
  conflictsWith: string[]
  supersededById: string | null
  observedAt: Date
  sourceKind: SourceKind
}

export interface FactsRun {
  corpus: Corpus
  facts: StoredFact[]
  reports: Map<string, ExtractionReport & { ms: number }>
  model: string | undefined
  promptHash: string
}

const runs = new Map<string, Promise<FactsRun>>()

/** Extract every document of `corpus`, oldest first, once per process. */
export function factsRun(corpus: Corpus): Promise<FactsRun> {
  const existing = runs.get(corpus.name)
  if (existing) return existing
  const run = (async (): Promise<FactsRun> => {
    const world = await corpusWorld(corpus, ['knowledge-extract'])
    await setTenantOverride(world.db, 'knowledge-facts', world.tenantId, true, world.userId)
    // A real tenant is named after its business, and the prompt tells the model it is no entity.
    if (corpus.organisation) {
      await world.db
        .update(tenants)
        .set({ name: corpus.organisation })
        .where(eq(tenants.id, world.tenantId))
    }
    const types = corpusEntityTypes()
    const reports = new Map<string, ExtractionReport & { ms: number }>()
    const ordered = [...corpus.docs].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
    )
    let model: string | undefined
    for (const doc of ordered) {
      const documentId = world.documentIdOf.get(doc.id)
      if (!documentId) throw new Error(`facts: ${doc.id} was not ingested`)
      const started = Date.now()
      const report = await withEvalScope(() =>
        extractDocumentFacts(
          world.db,
          world.cfg,
          world.env,
          { tenantId: world.tenantId, documentId },
          { types }
        )
      )
      if (report.status !== 'extracted') {
        throw new Error(`facts: ${doc.id} was not extracted (${report.status}: ${report.reason})`)
      }
      model ??= report.model
      reports.set(doc.id, { ...report, ms: Date.now() - started })
    }
    const allRows = await world.db
      .select({
        id: knowledgeFacts.id,
        entityType: knowledgeFacts.entityType,
        entityId: knowledgeFacts.entityId,
        key: knowledgeFacts.key,
        value: knowledgeFacts.value,
        documentId: knowledgeFacts.documentId,
        state: knowledgeFacts.state,
        conflictsWith: knowledgeFacts.conflictsWith,
        supersededById: knowledgeFacts.supersededById,
        observedAt: knowledgeFacts.observedAt,
        sourceKind: knowledgeFacts.sourceKind,
        valueRef: knowledgeFacts.valueRef,
      })
      .from(knowledgeFacts)
      .where(eq(knowledgeFacts.tenantId, world.tenantId))
    // Only the types the answer key covers are scored (the `person` type exists for `refs`).
    const scored = new Set(corpus.entities.map(e => e.entityType))
    const rows = allRows.filter(r => scored.has(r.entityType))
    const refIds = [
      ...new Set(rows.flatMap(r => (r.valueRef ? [r.valueRef.split(':').slice(2).join(':')] : []))),
    ]
    const entityIds = [...new Set([...rows.map(r => r.entityId), ...refIds])]
    const entities = entityIds.length
      ? await world.db
          .select({
            id: knowledgeEntities.id,
            type: knowledgeEntities.type,
            name: knowledgeEntities.name,
            aliases: knowledgeEntities.aliases,
          })
          .from(knowledgeEntities)
          .where(
            and(
              eq(knowledgeEntities.tenantId, world.tenantId),
              inArray(knowledgeEntities.id, entityIds)
            )
          )
      : []
    // A staging entity is named by its first mention; it also carries every other name it was
    // linked under. Score it under the first of those the answer key knows — the system does
    // know them all — or its own name when none is.
    const index = entityIndex(corpus.entities)
    const nameOf = new Map(
      entities.map(e => [
        e.id,
        [e.name, ...e.aliases].find(n => index.has(`${e.type}:${normalizeName(n)}`)) ?? e.name,
      ])
    )
    const namesOf = new Map(entities.map(e => [e.id, [e.name, ...e.aliases]]))
    const facts = rows.map(
      (r): StoredFact => ({
        factId: r.id,
        entityType: r.entityType,
        entity: nameOf.get(r.entityId) ?? r.entityId,
        key: r.key,
        value: r.value,
        valueNames: r.valueRef ? namesOf.get(r.valueRef.split(':').slice(2).join(':')) : undefined,
        doc: world.docIdOf.get(r.documentId) ?? r.documentId,
        documentId: r.documentId,
        state: r.state,
        conflictsWith: r.conflictsWith,
        supersededById: r.supersededById,
        observedAt: r.observedAt,
        sourceKind: r.sourceKind,
      })
    )
    const prompt = (await getPrompt(world.db, world.tenantId, 'knowledge-extract')).effectiveText
    return { corpus, facts, reports, model, promptHash: promptHash(prompt) }
  })()
  runs.set(corpus.name, run)
  return run
}

// ── Scoring ───────────────────────────────────────────────────────────────────────────────────

/** A case: one document (`doc`), the whole corpus (`all`), or the conflicts (`conflicts`). */
export interface FactsCase {
  id: string
  kind: 'doc' | 'all' | 'conflicts'
  doc?: string
}

export interface ConflictOutcome {
  caught: number
  falseAlarmRate: number
  score: number
  rationale: string
  winnerAccuracy: number | null
  winnerRationale: string
  flagged: { a: string | null; b: string | null; how: 'conflict' | 'supersession' }[]
  missed: string[]
}

/** The flagged pairs, the corpus-wide matching, and every number the conflicts case reports. */
export function scoreConflicts(run: Pick<FactsRun, 'corpus' | 'facts'>): ConflictOutcome {
  const { corpus, facts } = run
  const index = entityIndex(corpus.entities)
  const plantedClaims = corpus.facts.map(f => ({ ...f }))
  const matched = matchFacts(facts, plantedClaims, index)
  const plantedOf = new Map(facts.map((f, i) => [f.factId, matched[i] ?? null]))
  const byId = new Map(facts.map(f => [f.factId, f]))

  const pairs = new Map<
    string,
    { x: StoredFact; y: StoredFact; how: 'conflict' | 'supersession' }
  >()
  for (const f of facts) {
    for (const other of f.conflictsWith) {
      const y = byId.get(other)
      if (!y) continue
      const key = [f.factId, other].sort().join('|')
      if (!pairs.has(key)) pairs.set(key, { x: f, y, how: 'conflict' })
    }
    if (f.supersededById) {
      const y = byId.get(f.supersededById)
      if (y && y.documentId !== f.documentId) {
        const key = [f.factId, y.factId].sort().join('|')
        if (!pairs.has(key)) pairs.set(key, { x: f, y, how: 'supersession' })
      }
    }
  }

  const flaggedIds: [string, string][] = []
  let unmatched = 0
  const flagged: ConflictOutcome['flagged'] = []
  const preferredBy = new Map<string, string | null>()
  for (const { x, y, how } of pairs.values()) {
    const a = plantedOf.get(x.factId) ?? null
    const b = plantedOf.get(y.factId) ?? null
    flagged.push({ a, b, how })
    if (!a || !b) {
      unmatched += 1
      continue
    }
    flaggedIds.push([a, b])
    // Supersession: `x` is the superseded one, `y` the fact that replaced it.
    const preferred = how === 'supersession' ? y : isPreferredOver(x, y) ? x : y
    const pairKey = [a, b].sort().join('|')
    if (!preferredBy.has(pairKey)) preferredBy.set(pairKey, plantedOf.get(preferred.factId) ?? null)
  }
  const detection = conflictDetectionScore(flaggedIds, corpus.conflicts, unmatched)

  let judged = 0
  let right = 0
  const wrong: string[] = []
  const missed: string[] = []
  for (const c of corpus.conflicts) {
    const key = [c.a, c.b].sort().join('|')
    if (!preferredBy.has(key)) {
      missed.push(c.id)
      continue
    }
    judged += 1
    const want = c.winner === 'a' ? c.a : c.b
    if (preferredBy.get(key) === want) right += 1
    else wrong.push(c.id)
  }
  return {
    caught: detection.caught,
    falseAlarmRate: detection.falseAlarmRate,
    score: detection.score,
    rationale: `${detection.rationale}${missed.length ? ` · missed ${missed.join(', ')}` : ''}`,
    winnerAccuracy: judged === 0 ? null : right / judged,
    winnerRationale:
      judged === 0
        ? 'no planted conflict was caught'
        : `${right}/${judged} caught conflicts prefer the planted winner${wrong.length ? ` — wrong: ${wrong.join(', ')}` : ''}`,
    flagged,
    missed,
  }
}

/** `factExtractionScore` for one document, or the whole corpus. */
export function scoreExtraction(run: Pick<FactsRun, 'corpus' | 'facts'>, doc?: string) {
  const index = entityIndex(run.corpus.entities)
  const extracted = doc ? run.facts.filter(f => f.doc === doc) : run.facts
  const planted = doc ? run.corpus.facts.filter(f => f.doc === doc) : run.corpus.facts
  const score = factExtractionScore(extracted, planted, index)
  const matches = matchFacts(extracted, planted, index)
  const hit = new Set(matches.filter(Boolean))
  return {
    ...score,
    spurious: extracted
      .filter((_, i) => !matches[i])
      .map(f => `${f.doc}: ${f.entityType}/${f.entity}.${f.key} = ${JSON.stringify(f.value)}`),
    missing: planted.filter(p => !hit.has(p.id)).map(p => p.id),
  }
}

// ── Harness and judges ────────────────────────────────────────────────────────────────────────

const centsOf = (report: ExtractionReport) =>
  report.model
    ? estimateCostMicrocents(
        EVAL_PROVIDER.config?.provider ?? 'anthropic',
        report.model,
        report.usage
      )
    : null

export function factsHarness(corpus: Corpus): Harness<FactsCase, JsonValue> {
  return createHarness<FactsCase, JsonValue>({
    name: `rocketflare-facts · ${corpus.name}`,
    run: async ({ input }) => {
      const run = await factsRun(corpus)
      const reports = input.doc
        ? [run.reports.get(input.doc)].filter((r): r is NonNullable<typeof r> => Boolean(r))
        : input.kind === 'all'
          ? [...run.reports.values()]
          : []
      const inputTokens = reports.reduce((n, r) => n + r.usage.inputTokens, 0)
      const outputTokens = reports.reduce((n, r) => n + r.usage.outputTokens, 0)
      const cost = reports.reduce((n, r) => n + (centsOf(r) ?? 0), 0)
      let output: JsonValue
      if (input.kind === 'conflicts') {
        output = scoreConflicts(run) as unknown as JsonValue
      } else {
        const scored = scoreExtraction(run, input.doc)
        output = {
          precision: scored.precision,
          recall: scored.recall,
          rationale: scored.rationale,
          spurious: scored.spurious,
          missing: scored.missing,
        }
      }
      return {
        output,
        messages: [{ role: 'user', content: input.doc ?? input.id }],
        timings: { totalMs: reports.reduce((n, r) => n + r.ms, 0) },
        usage: {
          model: run.model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(reports.length ? { costUsd: cost / 1e8 } : {}),
        },
        artifacts: {
          promptKey: 'knowledge-extract',
          promptHash: run.promptHash,
          reports: reports.map(r => ({
            sections: r.sections,
            candidates: r.candidates,
            written: r.factIds.length,
            dropped: r.dropped,
            entitiesCreated: r.entitiesCreated,
            possibleMatches: r.possibleMatches,
          })) as unknown as JsonValue,
        },
      }
    },
  })
}

type Ctx = JudgeContext<FactsCase, JsonValue>
const out = (ctx: Ctx) => ctx.output as Record<string, unknown>

export const Precision = (): Judge<Ctx> => ({
  name: 'Precision',
  assess: ctx => ({
    score: Number(out(ctx).precision),
    metadata: { rationale: String(out(ctx).rationale) },
  }),
})

export const Recall = (): Judge<Ctx> => ({
  name: 'Recall',
  assess: ctx => ({
    score: Number(out(ctx).recall),
    metadata: { rationale: String(out(ctx).rationale) },
  }),
})

export const ConflictsCaught = (): Judge<Ctx> => ({
  name: 'ConflictsCaught',
  assess: ctx => ({
    score: Number(out(ctx).caught),
    metadata: { rationale: String(out(ctx).rationale) },
  }),
})

/** 1 − the false-alarm rate, so higher is better like every other score. */
export const NoFalseAlarms = (): Judge<Ctx> => ({
  name: 'NoFalseAlarms',
  assess: ctx => ({
    score: 1 - Number(out(ctx).falseAlarmRate),
    metadata: { rationale: String(out(ctx).rationale) },
  }),
})

export const WinnerAccuracy = (): Judge<Ctx> => ({
  name: 'WinnerAccuracy',
  assess: ctx => {
    const value = out(ctx).winnerAccuracy
    return {
      score: value === null ? null : Number(value),
      metadata: { rationale: String(out(ctx).winnerRationale) },
    }
  },
})
