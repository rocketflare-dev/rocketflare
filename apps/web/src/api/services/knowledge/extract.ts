/**
 * Knowledge-fact extraction (D43): one indexed document → typed facts about the registered entity
 * types, each verified against the passage it came from, resolved to an entity, and given a state
 * against what the tenant already holds. The `knowledge.extract` job calls `extractDocumentFacts`;
 * the facts eval calls the same function with its own `types`.
 *
 * Per document, in order (each stop is a `reason` in the returned report):
 *
 * 1. **Gates.** The document exists in the tenant, is `indexed`, and still has the text the job was
 *    enqueued for (`contentHash`); the tenant has the `knowledge-facts` flag; at least one entity
 *    type is registered; and `knowledgeExtractionAllowed` — under the daily cap, else the job
 *    re-enqueues itself for the next UTC day (`delaySeconds`, ≤ 12 h a hop) and does nothing else.
 * 2. **A fresh start.** The document's previous facts are deleted — a document's facts are a
 *    function of its current text — and the facts that disagreed only with them, or were superseded
 *    by them, go back to `accepted` / `unconfirmed` (`removeDocumentFacts`).
 * 3. **Sections.** Its stored chunks, consecutive ones joined up to `SECTION_MAX_CHARS` (chunks
 *    already begin and end at headings, so a section does too) — `buildSections`.
 * 4. **One model call per section**: the `knowledge-extract` prompt, then the types with each one's
 *    facts JSON schema, the document's title and date, the known entities the section mentions
 *    (names or aliases found in its text) with their accepted facts, and the section; ONE forced
 *    `submit_facts` call (`callStructuredTool`) on `resolveChat(…, { promptKey:
 *    'knowledge-extract' })`. Metered as `knowledge.extraction`.
 * 5. **Per candidate**: a registered type and key; the value through the key's schema
 *    (`coerceFactValue`, dates resolved against the document's date); `validFrom` / `validTo`
 *    resolved the same way (an unparseable one drops the fact); the quote located verbatim in the
 *    section (`locateQuote`) → `chunkId` and absolute `charStart`/`charEnd`; the entity resolved
 *    (`resolveMention`); a repeat of a fact this document already gave is dropped.
 * 6. **State** (`decideFactState`) against the facts held for that entity and key, written in one
 *    transaction with the updates it implies for the held ones.
 *
 * Trust comes from the document (`documentSourceKind`); the reviewer is the person an integration
 * named, else the owner, else null (admins see every item). Nothing here writes a domain column.
 */
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import {
  ANSWERABLE_FACT_STATES,
  entityFactsJsonSchema,
  type FactState,
  factValueSchema,
  type SourceKind,
} from '@rocketflare/shared/ai/knowledge-facts'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import {
  chunks,
  type DocumentRow,
  documents,
  knowledgeEntities,
  knowledgeFacts,
  tenants,
} from '../../../db/schema'
import { activeSpan, traceStep } from '../../observability/context'
import type { Tracer } from '../../observability/tracer'
import { traceChatClient, withAgentTrace } from '../../observability/tracing'
import type { Logger } from '../../utils/core/logger'
import { stripControlChars } from '../../utils/core/text'
import { callStructuredTool, StructuredOutputError } from '../ai/agent-loop'
import { AiNotConfiguredError } from '../ai/errors'
import { type ResolvedChat, resolveChat, resolveEmbeddings } from '../ai/resolve'
import type { AiEnv } from '../ai/types'
import { addUsage, ZERO_USAGE } from '../ai/types'
import {
  embedCounted,
  knowledgeExtractionAllowed,
  recordKnowledgeUsage,
  recordUsage,
} from '../ai/usage'
import { tenantFeatures } from '../features'
import { enqueueJob, type JobsQueue } from '../jobs'
import { resolvePrompt } from '../prompts'
import { resolveDatePhrase } from './dates'
import { type ResolveContext, type ResolvedEntity, resolveMention } from './entities'
import { restoredStateSql } from './facts-sql'
import { locateQuote } from './quotes'
import { knowledgeEntityTypes } from './registry'
import { decideFactState, type HeldFact, type Validity } from './state'
import type { EntityTypeRegistration } from './types'
import { coerceFactValue, valueKey, valueText } from './values'

/** The feature flag that turns extraction on for a tenant (default OFF). */
export const KNOWLEDGE_FACTS_FEATURE = 'knowledge-facts' as const

/** Characters of consecutive chunks one model call reads at most (one chunk is never split). */
export const SECTION_MAX_CHARS = 12_000
/** Facts one `submit_facts` call may carry. */
export const MAX_FACTS_PER_SECTION = 200
/** Known entities a section mentions by name or alias, listed with their accepted facts. */
const KNOWN_ENTITY_LIMIT = 40
/** Other known entities listed by name only, so a different wording can still be linked. */
const OTHER_ENTITY_LIMIT = 80
/** Accepted facts shown per mentioned entity. */
const FACTS_PER_ENTITY = 15
/** The longest a re-enqueue may wait (the queue's own maximum). */
const MAX_DELAY_SECONDS = 12 * 60 * 60

const SUBMIT_FACTS_TOOL = 'submit_facts'

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

const candidateSchema = z.object({
  entityType: z.string().describe('One of the registered entity types'),
  entityName: z.string().min(1).describe('The entity, by its known name when it is listed'),
  aliases: z
    .array(z.string())
    .optional()
    .describe('Other names this section uses for the same entity'),
  key: z.string().describe("One of the type's fact keys"),
  value: z
    .union([scalar, z.array(z.union([z.string(), z.number()]))])
    .describe("The value in the key's shape; a date exactly as the document writes it"),
  valueText: z.string().optional().describe('The value as the document words it'),
  quote: z.string().describe('The exact passage of this section that states the fact'),
  confidence: z.number().describe('0 to 1: how plainly the section states it'),
  validFrom: z
    .string()
    .nullish()
    .describe('When the value starts being true, as the document writes it; omit if unstated'),
  validTo: z
    .string()
    .nullish()
    .describe('When the value stops being true, as the document writes it; omit if unstated'),
})
export type FactCandidate = z.infer<typeof candidateSchema>

const submitFactsSchema = z.object({
  facts: z.array(candidateSchema).max(MAX_FACTS_PER_SECTION),
})

// ── Trust and review ──────────────────────────────────────────────────────────────────────────

/** A plugin's sync is `integration`, an agent's output (`source` `agent:<key>`) `agent`, else `upload`. */
export function documentSourceKind(
  doc: Pick<DocumentRow, 'origin' | 'source'>
): Exclude<SourceKind, 'person'> {
  if (doc.origin === 'integration') return 'integration'
  if (doc.source?.startsWith('agent:')) return 'agent'
  return 'upload'
}

/** Who is asked about this document's doubtful facts: the named reviewer, else the owner. */
export function documentReviewer(
  doc: Pick<DocumentRow, 'reviewerUserId' | 'ownerUserId'>
): string | null {
  return doc.reviewerUserId ?? doc.ownerUserId ?? null
}

// ── Sections ──────────────────────────────────────────────────────────────────────────────────

export interface SectionChunk {
  id: string
  /** Offsets of this chunk within `Section.text`. */
  start: number
  end: number
}

export interface Section {
  index: number
  text: string
  /** Absolute offset of `text` in `documents.content`, or null for chunks stored without one. */
  offset: number | null
  headingPath: string | null
  chunks: SectionChunk[]
}

interface ChunkRow {
  id: string
  seq: number
  text: string
  headingPath: string | null
  charStart: number | null
  charEnd: number | null
}

/**
 * Group a document's chunks (in `seq` order) into sections of at most `maxChars`: consecutive
 * chunks, joined through `documents.content` so the overlap between neighbours is read once. A
 * chunk with no stored offsets (written before 0.37.0) is a section of its own.
 */
export function buildSections(
  content: string,
  rows: readonly ChunkRow[],
  maxChars = SECTION_MAX_CHARS
): Section[] {
  const sections: Section[] = []
  let group: ChunkRow[] = []
  const flush = () => {
    if (group.length === 0) return
    const first = group[0] as ChunkRow
    const last = group[group.length - 1] as ChunkRow
    const offset = first.charStart as number
    sections.push({
      index: sections.length,
      text: content.slice(offset, last.charEnd as number),
      offset,
      headingPath: first.headingPath,
      chunks: group.map(c => ({
        id: c.id,
        start: (c.charStart as number) - offset,
        end: (c.charEnd as number) - offset,
      })),
    })
    group = []
  }
  for (const row of rows) {
    if (row.charStart === null || row.charEnd === null) {
      flush()
      sections.push({
        index: sections.length,
        text: row.text,
        offset: null,
        headingPath: row.headingPath,
        chunks: [{ id: row.id, start: 0, end: row.text.length }],
      })
      continue
    }
    const start = group[0]?.charStart ?? row.charStart
    if (group.length > 0 && row.charEnd - start > maxChars) flush()
    group.push(row)
  }
  flush()
  return sections
}

/** The chunk a quote at `[start, end)` of a section came from: the first that holds all of it. */
function chunkAt(section: Section, start: number, end: number): SectionChunk | undefined {
  return (
    section.chunks.find(c => c.start <= start && end <= c.end) ??
    section.chunks.find(c => c.start <= start && start < c.end)
  )
}

// ── Prompt material ───────────────────────────────────────────────────────────────────────────

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Each key of a type as one line of JSON schema, its description included. */
function renderType(reg: EntityTypeRegistration): string {
  const schema = entityFactsJsonSchema(reg) as { properties?: Record<string, unknown> }
  const lines = Object.entries(schema.properties ?? {}).map(
    ([key, prop]) => `- ${key}: ${JSON.stringify(prop)}`
  )
  return [`### ${reg.type} (${reg.label})`, ...lines].join('\n')
}

interface KnownEntity {
  id: string
  type: string
  name: string
  aliases: string[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does the section mention `name` as a whole word or phrase (case-insensitive)? */
function mentions(text: string, name: string): boolean {
  const n = name.trim()
  if (n.length < 2) return false
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text)
}

async function knownEntities(
  db: Database,
  tenantId: string,
  types: readonly string[]
): Promise<KnownEntity[]> {
  if (types.length === 0) return []
  return db
    .select({
      id: knowledgeEntities.id,
      type: knowledgeEntities.type,
      name: knowledgeEntities.name,
      aliases: knowledgeEntities.aliases,
    })
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.tenantId, tenantId),
        inArray(knowledgeEntities.type, [...types]),
        isNull(knowledgeEntities.mergedInto)
      )
    )
    .orderBy(asc(knowledgeEntities.createdAt))
    .limit(500)
}

async function acceptedFactsOf(
  db: Database,
  tenantId: string,
  entityIds: readonly string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (entityIds.length === 0) return out
  const rows = await db
    .select({
      entityId: knowledgeFacts.entityId,
      key: knowledgeFacts.key,
      valueText: knowledgeFacts.valueText,
    })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.entityKind, 'staging'),
        inArray(knowledgeFacts.entityId, [...entityIds]),
        eq(knowledgeFacts.state, 'accepted')
      )
    )
    .orderBy(asc(knowledgeFacts.observedAt))
  for (const row of rows) {
    const list = out.get(row.entityId) ?? []
    const line = `${row.key} = ${row.valueText}`
    if (!list.includes(line) && list.length < FACTS_PER_ENTITY) list.push(line)
    out.set(row.entityId, list)
  }
  return out
}

/** The user turn for one section: the document, the types, the known entities, the text. */
export function sectionMessage(input: {
  title: string
  documentDate: Date
  section: Section
  sectionCount: number
  types: readonly EntityTypeRegistration[]
  mentioned: readonly (KnownEntity & { facts: string[] })[]
  others?: readonly KnownEntity[]
}): string {
  const { title, documentDate, section, sectionCount, types, mentioned, others = [] } = input
  const date = documentDate.toISOString().slice(0, 10)
  const parts = [
    `Document: ${JSON.stringify(title)}`,
    `Written: ${date} (${WEEKDAY[documentDate.getUTCDay()]})`,
    `Section ${section.index + 1} of ${sectionCount}${section.headingPath ? ` — ${section.headingPath}` : ''}`,
    '',
    '## Entity types and their fact keys',
    types.map(renderType).join('\n\n'),
  ]
  if (mentioned.length > 0) {
    parts.push('', '## Known entities this section mentions by name')
    for (const e of mentioned) {
      const also = e.aliases.length > 0 ? ` (also: ${e.aliases.join(', ')})` : ''
      const facts = e.facts.length > 0 ? ` — accepted facts: ${e.facts.join('; ')}` : ''
      parts.push(`- ${e.type} ${JSON.stringify(e.name)}${also}${facts}`)
    }
  }
  if (others.length > 0) {
    parts.push('', '## Other known entities (names only — use one only for the SAME entity)')
    const byType = new Map<string, string[]>()
    for (const e of others) byType.set(e.type, [...(byType.get(e.type) ?? []), e.name])
    for (const [type, names] of byType) parts.push(`- ${type}: ${names.join('; ')}`)
  }
  parts.push('', '## Section', '<<<', section.text, '>>>')
  return parts.join('\n')
}

// ── Removing a document's facts ───────────────────────────────────────────────────────────────

const uuidArray = (ids: readonly string[]) =>
  sql`ARRAY[${sql.join(
    ids.map(id => sql`${id}`),
    sql`, `
  )}]::uuid[]`

/**
 * Delete a document's facts and undo what they did to the rest: their ids leave every
 * `conflicts_with`, a fact left conflicting with nothing — or superseded by a fact that no longer
 * exists (the FK set it null) — returns to `accepted` (a person confirmed it, or it was read
 * confidently) or `unconfirmed`. A person's decisions on OTHER documents' facts (`rejected`, a
 * confirmation) are untouched.
 */
export async function removeDocumentFacts(
  db: Database,
  tenantId: string,
  documentId: string
): Promise<number> {
  return db.transaction(async tx => {
    const removed = await tx
      .delete(knowledgeFacts)
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.documentId, documentId)))
      .returning({ id: knowledgeFacts.id })
    if (removed.length === 0) return 0
    const ids = uuidArray(removed.map(r => r.id))
    await tx
      .update(knowledgeFacts)
      .set({
        conflictsWith: sql`array(select x from unnest(${knowledgeFacts.conflictsWith}) as x where x <> all(${ids}))`,
      })
      .where(
        and(eq(knowledgeFacts.tenantId, tenantId), sql`${knowledgeFacts.conflictsWith} && ${ids}`)
      )
    await tx
      .update(knowledgeFacts)
      .set({ state: restoredStateSql })
      .where(
        and(
          eq(knowledgeFacts.tenantId, tenantId),
          sql`((${knowledgeFacts.state} = 'conflicting' and cardinality(${knowledgeFacts.conflictsWith}) = 0) or (${knowledgeFacts.state} = 'superseded' and ${knowledgeFacts.supersededById} is null))`
        )
      )
    return removed.length
  })
}

// ── The run ───────────────────────────────────────────────────────────────────────────────────

export type DropReason =
  | 'unknown_type'
  | 'unknown_key'
  | 'bad_value'
  | 'bad_date'
  | 'quote_not_found'
  | 'duplicate'
  /**
   * One section gave one entity two different values for one key over the SAME validity — a
   * document cannot disagree with itself in one place, so the reading is wrong (two columns of a
   * table put on one entity), and neither value is written.
   */
  | 'ambiguous'

/** A candidate that passed every check, waiting for the section's ambiguity check. */
interface PreparedFact {
  candidate: FactCandidate
  reg: EntityTypeRegistration
  entity: ResolvedEntity
  key: string
  value: unknown
  vKey: string
  validity: Validity
  located: { start: number; end: number }
}

export interface ExtractionReport {
  status: 'extracted' | 'skipped' | 'paused'
  /** Why it was skipped or paused. */
  reason?:
    | 'document_missing'
    | 'not_indexed'
    | 'content_changed'
    | 'feature_off'
    | 'no_entity_types'
    | 'no_chat_model'
    | 'daily_cap'
  sections: number
  /** Sections whose `submit_facts` call failed validation twice (skipped, the rest go on). */
  failedSections: number
  candidates: number
  dropped: Partial<Record<DropReason, number>>
  /** The facts written, in order. */
  factIds: string[]
  /** Facts of this document removed before extracting again. */
  replaced: number
  /** The new staging entities, and how many of them carry a possible match. */
  entitiesCreated: number
  possibleMatches: number
  usage: TokenUsage
  model?: string
  /** `paused`: the re-enqueue's delay. */
  delaySeconds?: number
}

export interface ExtractDeps {
  /** `env.JOBS_QUEUE` — for the next-day re-enqueue when the cap is reached. */
  jobs?: JobsQueue | null
  /** A trace of its own on this tracer when no span is active (a job passes `ctx.tracer`). */
  tracer?: Tracer
  logger?: Pick<Logger, 'info' | 'warn'>
  /**
   * Replace the registry (`knowledgeEntityTypes()`). The facts eval registers its corpus's types
   * this way; nothing in the app passes it.
   */
  types?: readonly EntityTypeRegistration[]
  now?: () => Date
}

export interface ExtractInput {
  tenantId: string
  documentId: string
  /** The text the enqueue saw; a document whose hash differs now is skipped. */
  contentHash?: string
}

const emptyReport = (status: ExtractionReport['status'], reason?: ExtractionReport['reason']) =>
  ({
    status,
    reason,
    sections: 0,
    failedSections: 0,
    candidates: 0,
    dropped: {},
    factIds: [],
    replaced: 0,
    entitiesCreated: 0,
    possibleMatches: 0,
    usage: { ...ZERO_USAGE },
  }) satisfies ExtractionReport

/** Seconds until the next UTC midnight (plus a minute), capped at the queue's maximum delay. */
export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  const seconds = Math.ceil((next - now.getTime()) / 1000) + 60
  return Math.min(MAX_DELAY_SECONDS, Math.max(60, seconds))
}

/**
 * Extract a document's facts. Never throws for a gate (the report says which); throws for a
 * provider or database failure, so the job retries — and a retry starts by deleting what the
 * failed attempt wrote.
 */
export async function extractDocumentFacts(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: ExtractInput,
  deps: ExtractDeps = {}
): Promise<ExtractionReport> {
  const run = () => runExtraction(db, cfg, env, input, deps)
  const describe = (r: ExtractionReport) => ({
    output: {
      status: r.status,
      reason: r.reason,
      sections: r.sections,
      candidates: r.candidates,
      written: r.factIds.length,
      dropped: r.dropped,
      replaced: r.replaced,
    },
  })
  if (activeSpan() || !deps.tracer) {
    return traceStep(
      { name: 'knowledge extract', kind: 'span', input: { documentId: input.documentId } },
      run,
      describe
    )
  }
  return withAgentTrace(
    'knowledge.extract',
    {
      tracer: deps.tracer,
      tenantId: input.tenantId,
      kind: 'job',
      spanName: 'job knowledge.extract',
      metadata: { documentId: input.documentId },
    },
    async () => run()
  )
}

async function runExtraction(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  input: ExtractInput,
  deps: ExtractDeps
): Promise<ExtractionReport> {
  const { tenantId, documentId } = input
  const now = deps.now?.() ?? new Date()
  const doc = await db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)),
  })
  if (!doc) return emptyReport('skipped', 'document_missing')
  if (doc.status !== 'indexed' || doc.content === null) return emptyReport('skipped', 'not_indexed')
  if (input.contentHash && doc.contentHash !== input.contentHash) {
    return emptyReport('skipped', 'content_changed')
  }
  const types = deps.types ?? knowledgeEntityTypes()
  if (types.length === 0) return emptyReport('skipped', 'no_entity_types')
  if (!(await tenantFeatures(db, cfg, tenantId)).includes(KNOWLEDGE_FACTS_FEATURE)) {
    return emptyReport('skipped', 'feature_off')
  }
  if (!(await knowledgeExtractionAllowed(db, cfg, tenantId, now))) {
    const delaySeconds = secondsUntilNextUtcDay(now)
    await enqueueJob(
      deps.jobs,
      {
        type: 'knowledge.extract',
        payload: { tenantId, documentId, contentHash: doc.contentHash ?? undefined },
      },
      { delaySeconds }
    )
    deps.logger?.info(
      { tenantId, documentId, delaySeconds },
      'knowledge.extract: daily cap, paused'
    )
    return { ...emptyReport('paused', 'daily_cap'), delaySeconds }
  }

  let chat: ResolvedChat
  try {
    chat = await resolveChat(db, cfg, env, tenantId, { promptKey: 'knowledge-extract' })
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return emptyReport('skipped', 'no_chat_model')
    throw err
  }

  const report: ExtractionReport = emptyReport('extracted')
  report.model = chat.model
  report.replaced = await removeDocumentFacts(db, tenantId, documentId)

  const rows = await db
    .select({
      id: chunks.id,
      seq: chunks.seq,
      text: chunks.text,
      headingPath: chunks.headingPath,
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
    })
    .from(chunks)
    .where(and(eq(chunks.tenantId, tenantId), eq(chunks.documentId, documentId)))
    .orderBy(asc(chunks.seq))
  const sections = buildSections(doc.content, rows)
  report.sections = sections.length
  if (sections.length === 0) return report

  const tenant = await db.query.tenants.findFirst({
    columns: { name: true },
    where: eq(tenants.id, tenantId),
  })
  const system = await resolvePrompt(db, tenantId, 'knowledge-extract', {
    appName: cfg.APP_NAME,
    tenantName: tenant?.name ?? '',
  })
  const typeByName = new Map(types.map(t => [t.type, t]))
  const documentDate = doc.createdAt
  const sourceKind = documentSourceKind(doc)
  const reviewerUserId = documentReviewer(doc)
  const visibility = doc.visibility === 'groups' ? 'groups' : 'tenant'

  const resolveCtx: ResolveContext = {
    db,
    tenantId,
    reviewerUserId,
    embedName: await nameEmbedder(db, cfg, env, tenantId, doc.ownerUserId),
  }
  const entityCache = new Map<string, ResolvedEntity>()
  const written = new Set<string>()
  const created = new Set<string>()
  const drop = (reason: DropReason) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + 1
  }

  for (const section of sections) {
    const known = await knownEntities(
      db,
      tenantId,
      types.map(t => t.type)
    )
    const mentionedRows = known
      .filter(e => [e.name, ...e.aliases].some(n => mentions(section.text, n)))
      .slice(0, KNOWN_ENTITY_LIMIT)
    const mentionedIds = new Set(mentionedRows.map(e => e.id))
    const others = known.filter(e => !mentionedIds.has(e.id)).slice(0, OTHER_ENTITY_LIMIT)
    const facts = await acceptedFactsOf(
      db,
      tenantId,
      mentionedRows.map(e => e.id)
    )
    const message = sectionMessage({
      title: doc.title,
      documentDate,
      section,
      sectionCount: sections.length,
      types,
      mentioned: mentionedRows.map(e => ({ ...e, facts: facts.get(e.id) ?? [] })),
      others,
    })

    let candidates: FactCandidate[]
    try {
      candidates = await traceStep(
        {
          name: `extract section ${section.index + 1}`,
          kind: 'span',
          input: { chars: section.text.length },
        },
        async () => {
          const parent = activeSpan()
          const client = parent
            ? traceChatClient(chat.client, parent, { provider: chat.provider })
            : chat.client
          const result = await callStructuredTool(client, {
            model: chat.model,
            maxTokens: chat.maxOutputTokens,
            system,
            messages: [{ role: 'user', content: message }],
            tool: {
              name: SUBMIT_FACTS_TOOL,
              description:
                'Submit every fact this section states about the registered entity types. Call exactly once; an empty list when there are none.',
              schema: submitFactsSchema,
            },
            onUsage: usage => {
              report.usage = addUsage(report.usage, usage)
              void recordExtractionUsage(db, tenantId, doc.ownerUserId, chat, usage)
            },
          })
          return result.facts
        },
        result => ({ output: { candidates: result.length } })
      )
    } catch (err) {
      if (err instanceof StructuredOutputError) {
        report.failedSections += 1
        deps.logger?.warn(
          { tenantId, documentId, section: section.index, issues: err.issues },
          'knowledge.extract: section skipped, no valid submit_facts call'
        )
        continue
      }
      throw err
    }
    report.candidates += candidates.length

    const prepared: PreparedFact[] = []
    for (const candidate of candidates) {
      const reg = typeByName.get(candidate.entityType.trim())
      if (!reg) {
        drop('unknown_type')
        continue
      }
      const schema = factValueSchema(reg, candidate.key.trim())
      if (!schema) {
        drop('unknown_key')
        continue
      }
      let coerced = coerceFactValue(schema, candidate.value, documentDate)
      if (!coerced.ok && candidate.valueText) {
        coerced = coerceFactValue(schema, candidate.valueText, documentDate)
      }
      if (!coerced.ok) {
        drop('bad_value')
        continue
      }
      const validity = resolveValidity(candidate, documentDate)
      if (!validity) {
        drop('bad_date')
        continue
      }
      const located = locateQuote(section.text, candidate.quote)
      if (!located) {
        drop('quote_not_found')
        continue
      }
      const entity = await resolveMention(
        resolveCtx,
        reg,
        { name: candidate.entityName, aliases: candidate.aliases ?? [] },
        entityCache
      )
      if (entity.created && !created.has(entity.id)) {
        created.add(entity.id)
        report.entitiesCreated += 1
        if (entity.possibleMatch) report.possibleMatches += 1
      }
      prepared.push({
        candidate,
        reg,
        entity,
        key: candidate.key.trim(),
        value: coerced.value,
        vKey: valueKey(coerced.value),
        validity,
        located,
      })
    }

    // A section that gives one entity two values for one key over one window misread itself.
    const valuesPerSlot = new Map<string, Set<string>>()
    const slotOf = (p: PreparedFact) =>
      `${p.entity.kind}:${p.entity.id}:${p.key}:${p.validity.validFrom?.getTime() ?? ''}:${p.validity.validTo?.getTime() ?? ''}`
    for (const p of prepared) {
      const slot = slotOf(p)
      valuesPerSlot.set(slot, (valuesPerSlot.get(slot) ?? new Set()).add(p.vKey))
    }

    for (const { candidate, reg, entity, key, value, vKey, validity, located } of prepared) {
      if ((valuesPerSlot.get(slotOf({ entity, key, validity } as PreparedFact))?.size ?? 0) > 1) {
        drop('ambiguous')
        continue
      }
      const dedupe = `${entity.kind}:${entity.id}:${key}:${vKey}`
      if (written.has(dedupe)) {
        drop('duplicate')
        continue
      }
      written.add(dedupe)
      const chunk = chunkAt(section, located.start, located.end)
      const id = await writeFact(db, {
        tenantId,
        entityKind: entity.kind,
        entityType: reg.type,
        entityId: entity.id,
        key,
        value,
        valueText: valueText(value),
        valueKey: vKey,
        documentId,
        chunkId: chunk?.id ?? null,
        charStart: section.offset === null ? null : section.offset + located.start,
        charEnd: section.offset === null ? null : section.offset + located.end,
        quote: stripControlChars(section.text.slice(located.start, located.end)),
        sourceKind,
        confidence: clamp01(candidate.confidence),
        validFrom: validity.validFrom,
        validTo: validity.validTo,
        observedAt: documentDate,
        reviewerUserId,
        visibility,
      })
      report.factIds.push(id)
    }
  }
  deps.logger?.info(
    {
      tenantId,
      documentId,
      sections: report.sections,
      candidates: report.candidates,
      written: report.factIds.length,
      dropped: report.dropped,
    },
    'knowledge.extract: done'
  )
  return report
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** `validFrom` / `validTo` as dates, or null when either is present and unreadable. */
function resolveValidity(
  candidate: Pick<FactCandidate, 'validFrom' | 'validTo'>,
  documentDate: Date
): { validFrom: Date | null; validTo: Date | null } | null {
  const read = (phrase: string | null | undefined, bound: 'start' | 'end') => {
    const text = phrase?.trim()
    if (!text || /^(n\/?a|none|null|unknown|unspecified|ongoing|open[- ]ended)$/i.test(text)) {
      return { ok: true as const, date: null }
    }
    const iso = resolveDatePhrase(text, documentDate, bound)
    return iso ? { ok: true as const, date: new Date(`${iso}T00:00:00Z`) } : { ok: false as const }
  }
  const from = read(candidate.validFrom, 'start')
  const to = read(candidate.validTo, 'end')
  if (!from.ok || !to.ok) return null
  if (from.date && to.date && from.date.getTime() > to.date.getTime()) return null
  return { validFrom: from.date, validTo: to.date }
}

/** One `knowledge.extraction` row per section call; never fails the extraction. */
async function recordExtractionUsage(
  db: Database,
  tenantId: string,
  userId: string | null,
  chat: ResolvedChat,
  usage: TokenUsage
): Promise<void> {
  try {
    await recordUsage(db, {
      tenantId,
      userId,
      feature: KNOWLEDGE_USAGE_FEATURES.extraction,
      provider: chat.provider,
      model: chat.model,
      usage,
    })
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: 'knowledge extraction usage not recorded',
        tenantId,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
    )
  }
}

/** Embeds an entity name for resolution, metered as `knowledge.embeddings`; null without an embedder. */
async function nameEmbedder(
  db: Database,
  cfg: AppConfig,
  env: AiEnv,
  tenantId: string,
  userId: string | null
): Promise<ResolveContext['embedName']> {
  let embeddings: Awaited<ReturnType<typeof resolveEmbeddings>>
  try {
    embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  } catch (err) {
    if (err instanceof AiNotConfiguredError) return null
    throw err
  }
  return async name => {
    const counted = await embedCounted(embeddings.client, [name])
    await recordKnowledgeUsage(db, [
      {
        tenantId,
        userId,
        feature: KNOWLEDGE_USAGE_FEATURES.embeddings,
        provider: embeddings.provider,
        model: embeddings.model,
        inputTokens: counted.inputTokens,
      },
    ])
    const vector = counted.vectors[0]
    return vector ? { vector, model: embeddings.model } : null
  }
}

interface FactToWrite {
  tenantId: string
  entityKind: 'domain' | 'staging'
  entityType: string
  entityId: string
  key: string
  value: unknown
  valueText: string
  valueKey: string
  documentId: string
  chunkId: string | null
  charStart: number | null
  charEnd: number | null
  quote: string
  sourceKind: SourceKind
  confidence: number
  validFrom: Date | null
  validTo: Date | null
  observedAt: Date
  reviewerUserId: string | null
  visibility: 'tenant' | 'groups'
}

/** Decide the state against the held facts and write it, with the held facts' updates, as one. */
async function writeFact(db: Database, fact: FactToWrite): Promise<string> {
  return db.transaction(async tx => {
    const heldRows = await tx
      .select({
        id: knowledgeFacts.id,
        state: knowledgeFacts.state,
        value: knowledgeFacts.value,
        validFrom: knowledgeFacts.validFrom,
        validTo: knowledgeFacts.validTo,
      })
      .from(knowledgeFacts)
      .where(
        and(
          eq(knowledgeFacts.tenantId, fact.tenantId),
          eq(knowledgeFacts.entityKind, fact.entityKind),
          eq(knowledgeFacts.entityType, fact.entityType),
          eq(knowledgeFacts.entityId, fact.entityId),
          eq(knowledgeFacts.key, fact.key),
          inArray(knowledgeFacts.state, [...ANSWERABLE_FACT_STATES])
        )
      )
    const held: HeldFact[] = heldRows.map(r => ({
      id: r.id,
      state: r.state as FactState,
      valueKey: valueKey(r.value),
      validFrom: r.validFrom,
      validTo: r.validTo,
    }))
    const decision = decideFactState(
      {
        valueKey: fact.valueKey,
        confidence: fact.confidence,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
      },
      held
    )
    const { valueKey: _key, ...row } = fact
    const [inserted] = await tx
      .insert(knowledgeFacts)
      .values({
        ...row,
        state: decision.state,
        conflictsWith: decision.conflictsWith,
        supersededById: decision.supersededBy,
      })
      .returning({ id: knowledgeFacts.id })
    if (!inserted) throw new Error('knowledge_facts: insert returned no row')
    const scoped = (ids: string[]) =>
      and(eq(knowledgeFacts.tenantId, fact.tenantId), inArray(knowledgeFacts.id, ids))
    if (decision.conflictsWith.length > 0) {
      await tx
        .update(knowledgeFacts)
        .set({
          state: 'conflicting',
          conflictsWith: sql`array_append(${knowledgeFacts.conflictsWith}, ${inserted.id}::uuid)`,
        })
        .where(scoped(decision.conflictsWith))
    }
    if (decision.supersedes.length > 0) {
      await tx
        .update(knowledgeFacts)
        .set({ state: 'superseded', supersededById: inserted.id })
        .where(scoped(decision.supersedes))
    }
    if (decision.confirms.length > 0) {
      await tx
        .update(knowledgeFacts)
        .set({ state: 'accepted' })
        .where(and(scoped(decision.confirms), eq(knowledgeFacts.state, 'unconfirmed')))
    }
    return inserted.id
  })
}
