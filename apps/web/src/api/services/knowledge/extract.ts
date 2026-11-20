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
 *    by them, go back to `accepted` / `unconfirmed` (`removeDocumentFacts`). **Except a person's
 *    decisions**: a fact somebody confirmed or rejected stays, and a new reading of the same entity,
 *    key and value takes its place IN the kept row (fresh citation, same decision — rejected stays
 *    rejected, confirmed stays confirmed by the same person). A kept fact the new reading does not
 *    repeat is deleted when the run ends, unless a section failed. Kept in the table, not in
 *    memory, so a retried run still finds them.
 * 3. **Sections.** Its stored chunks, consecutive ones joined up to `SECTION_MAX_CHARS` (chunks
 *    already begin and end at headings, so a section does too) — `buildSections`.
 * 4. **One model call per section**: the `knowledge-extract` prompt, then the types with each one's
 *    facts JSON schema, the document's title and date, the known entities the section mentions
 *    (names or aliases found in its text) with their accepted facts — both from tenant-visible
 *    documents only (`promptScope`) — and the section; ONE forced
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
  factRefType,
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
import { type AccessScope, visibleDocuments } from '../access'
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
import { nudge, type Realtime, realtimeEvent } from '../realtime'
import { resolveDatePhrase } from './dates'
import {
  commitPlanned,
  linkPlanned,
  type Mention,
  normaliseName,
  type PlannedEntity,
  planMention,
  type ResolveContext,
  type ResolvedEntity,
} from './entities'
import { entityVisibleSql } from './facts-sql'
import {
  type EntityQuestion,
  type KnowledgeJudge,
  knowledgeJudgeFor,
  type ValueQuestion,
} from './judge'
import { judgedPairId, loadJudged, storeJudgements } from './judgements'
import { locateQuote } from './quotes'
import { knowledgeEntityTypes } from './registry'
import { decidedSql, removeDocumentFacts, removeFacts } from './remove'
import { recomputeKey } from './review'
import {
  decideFactState,
  type HeldFact,
  type JudgedPair,
  type Validity,
  windowOrder,
} from './state'
import type { EntityTypeRegistration } from './types'
import { coerceFactValue, factCompareKey, valueKey, valueRefOf, valueText } from './values'

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

/**
 * The longest a model-returned value, its wording or a validity date may be. A real one is a few
 * words; a longer one is dropped (`bad_value` / `bad_date`) before any coercion reads it, so the
 * cost of checking a candidate never grows with what an endpoint chose to send back. Checked per
 * candidate rather than in the tool schema, so one over-long candidate does not cost the section
 * its other facts.
 */
export const MAX_CANDIDATE_TEXT_CHARS = 2000

function overLong(value: unknown): boolean {
  if (typeof value === 'string') return value.length > MAX_CANDIDATE_TEXT_CHARS
  return Array.isArray(value) && value.some(overLong)
}

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
  const lines = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
    const names = factRefType(reg, key)
    // A key that names an entity: its value is that entity's name, exactly as the section writes it.
    const ref = names ? ` — names a ${names} entity: give the name as written` : ''
    return `- ${key}: ${JSON.stringify(prop)}${ref}`
  })
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

/**
 * Whose view the material a model is SHOWN while it reads a document is built from: a reader who
 * sees only tenant-visible documents. Everyone who may open the document being read may open
 * those, so the known entities, their accepted facts and the held values a judge compares never
 * carry a name or a value from a group-restricted document — which a model could otherwise copy
 * into a document with a wider audience. Writing is unaffected: a fact's state is still decided
 * against every fact the tenant holds, and the readers mask what they cannot see.
 */
function promptScope(tenantId: string): AccessScope {
  return { tenantId, userId: null, groupIds: [], bypass: false }
}

/** `documents` joined to the outer `knowledge_facts` row, in the tenant. */
const factDocument = (tenantId: string) =>
  and(eq(documents.id, knowledgeFacts.documentId), eq(documents.tenantId, tenantId))

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
        isNull(knowledgeEntities.mergedInto),
        entityVisibleSql(promptScope(tenantId))
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
    .innerJoin(documents, factDocument(tenantId))
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.entityKind, 'staging'),
        inArray(knowledgeFacts.entityId, [...entityIds]),
        eq(knowledgeFacts.state, 'accepted'),
        visibleDocuments(promptScope(tenantId))
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

/** A kept decided fact of this document, as the run matches it. */
interface DecidedFact {
  id: string
  entityKind: 'domain' | 'staging'
  entityType: string
  entityId: string
  key: string
  valueKey: string
  state: FactState
  validFrom: Date | null
  validTo: Date | null
}

async function decidedFactsOf(
  db: Database,
  tenantId: string,
  documentId: string
): Promise<DecidedFact[]> {
  const rows = await db
    .select({
      id: knowledgeFacts.id,
      entityKind: knowledgeFacts.entityKind,
      entityType: knowledgeFacts.entityType,
      entityId: knowledgeFacts.entityId,
      key: knowledgeFacts.key,
      value: knowledgeFacts.value,
      valueRef: knowledgeFacts.valueRef,
      state: knowledgeFacts.state,
      validFrom: knowledgeFacts.validFrom,
      validTo: knowledgeFacts.validTo,
    })
    .from(knowledgeFacts)
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        eq(knowledgeFacts.documentId, documentId),
        decidedSql
      )
    )
    .orderBy(asc(knowledgeFacts.createdAt))
  return rows.map(({ value, valueRef, ...r }) => ({
    ...r,
    state: r.state as FactState,
    valueKey: factCompareKey({ value, valueRef }),
  }))
}

const sameTime = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null)

/**
 * The decided fact a new reading repeats — same entity, key and value — preferring one with the
 * same validity; each decided fact is matched at most once.
 */
function matchDecided(
  decided: readonly DecidedFact[],
  used: ReadonlySet<string>,
  fact: {
    entityKind: string
    entityType: string
    entityId: string
    key: string
    valueKey: string
  } & Validity,
  judged?: JudgedPair
): DecidedFact | undefined {
  const same = decided.filter(
    d =>
      !used.has(d.id) &&
      d.entityKind === fact.entityKind &&
      d.entityType === fact.entityType &&
      d.entityId === fact.entityId &&
      d.key === fact.key &&
      (d.valueKey === fact.valueKey || judged?.(d.valueKey, fact.valueKey) === 'same')
  )
  return (
    same.find(d => sameTime(d.validFrom, fact.validFrom) && sameTime(d.validTo, fact.validTo)) ??
    same[0]
  )
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

/** A candidate that passed every check of its own, its entity not yet decided. */
interface CheckedFact {
  candidate: FactCandidate
  reg: EntityTypeRegistration
  /** `<type>:<normalised mention name>` — one per distinct mention of the section. */
  mentionKey: string
  key: string
  value: unknown
  vKey: string
  validity: Validity
  located: { start: number; end: number }
  /** A `refs` key: the mention its value is (`<ref type>:<normalised name>`). */
  refMentionKey?: string
  refType?: string
}

/** …and with its entity, once the section's ambiguity check has passed it. */
interface PreparedFact extends CheckedFact {
  entity: ResolvedEntity
  /** The entity a `refs` key's value names, as `value_ref`. */
  valueRef: string | null
}

/** A mention's entity inside one section: resolved, or a staging entity not yet written. */
type SectionEntity = ResolvedEntity | { kind: 'staging'; id: string; pending: true }

/** Remember an entity under every name of its mention, for the rest of the run. */
function cacheEntity(
  cache: Map<string, ResolvedEntity>,
  type: string,
  names: readonly string[],
  entity: ResolvedEntity
) {
  for (const n of names) if (n.trim()) cache.set(`${type}:${normaliseName(n)}`, entity)
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
  /** Facts of this document removed: before extracting again, and decided ones not read again. */
  replaced: number
  /**
   * Facts a person had settled (confirmed, rejected) that this reading repeated — same entity, key
   * and value — and that therefore kept their decision (their ids are in `factIds`).
   */
  decisionsKept: number
  /** The new staging entities, and how many of them carry a possible match. */
  entitiesCreated: number
  possibleMatches: number
  /**
   * What the decision model settled (`judge.ts`): mentions linked to a known entity, mentions it
   * said were new (no possible-match item), value pairs asked, and pairs it said agree.
   */
  judged: { entitiesLinked: number; entitiesNew: number; valuePairs: number; valuesAgreed: number }
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
  /**
   * Where the `entity.changed { entity: 'knowledge' }` nudge goes once the run has written (a job
   * passes `collectingRealtime(env)` and awaits its flush). Omitted: no nudge.
   */
  realtime?: Realtime
  /** Replace the decision model (`knowledgeJudgeFor`) — tests pass a scripted one. */
  judge?: KnowledgeJudge
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
    decisionsKept: 0,
    entitiesCreated: 0,
    possibleMatches: 0,
    judged: { entitiesLinked: 0, entitiesNew: 0, valuePairs: 0, valuesAgreed: 0 },
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
      decisionsKept: r.decisionsKept,
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
      spanName: 'invoke_workflow knowledge.extract',
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
  report.replaced = await removeDocumentFacts(db, tenantId, documentId, { keepDecided: true })
  const decided = await decidedFactsOf(db, tenantId, documentId)
  const kept = new Set<string>()
  /**
   * The decided facts this reading did not repeat go now — unless a section failed, when the
   * reading is incomplete and their absence is no evidence (they stay until the next run).
   */
  const finish = async () => {
    const stale = decided.filter(d => !kept.has(d.id)).map(d => d.id)
    if (stale.length > 0 && report.failedSections === 0) {
      report.replaced += await removeFacts(db, tenantId, inArray(knowledgeFacts.id, stale))
    }
    if (report.replaced > 0 || report.factIds.length > 0) {
      nudge(deps.realtime, realtimeEvent('entity.changed', tenantId, { entity: 'knowledge' }))
    }
    return report
  }

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
  if (sections.length === 0) return finish()

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
    documentVisibility: visibility,
    reviewerUserId,
    embedName: await nameEmbedder(db, cfg, env, tenantId, doc.ownerUserId),
  }
  const judge =
    deps.judge ??
    knowledgeJudgeFor(db, cfg, env, tenantId, doc.ownerUserId, tenant?.name ?? '', deps.logger)
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

    // 1. Check every candidate — type, key, value, dates, quote — before any entity is touched.
    const checked: CheckedFact[] = []
    const mentionsByKey = new Map<string, { reg: EntityTypeRegistration; mention: Mention }>()
    for (const candidate of candidates) {
      const reg = typeByName.get(candidate.entityType.trim())
      if (!reg) {
        drop('unknown_type')
        continue
      }
      const key = candidate.key.trim()
      const schema = factValueSchema(reg, key)
      if (!schema) {
        drop('unknown_key')
        continue
      }
      if (overLong(candidate.value) || overLong(candidate.valueText)) {
        drop('bad_value')
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
      const validity =
        overLong(candidate.validFrom) || overLong(candidate.validTo)
          ? null
          : resolveValidity(candidate, documentDate)
      if (!validity) {
        drop('bad_date')
        continue
      }
      const located = locateQuote(section.text, candidate.quote)
      if (!located) {
        drop('quote_not_found')
        continue
      }
      const mentionKey = `${reg.type}:${normaliseName(candidate.entityName)}`
      const seen = mentionsByKey.get(mentionKey)
      const aliases = candidate.aliases ?? []
      if (seen) {
        seen.mention = { ...seen.mention, aliases: [...seen.mention.aliases, ...aliases] }
      } else {
        mentionsByKey.set(mentionKey, { reg, mention: { name: candidate.entityName, aliases } })
      }
      // A key that names an entity (`refs`): its value is a mention of that type too.
      const refType = factRefType(reg, key)
      const refReg = refType ? typeByName.get(refType) : undefined
      let refMentionKey: string | undefined
      if (refReg && typeof coerced.value === 'string') {
        refMentionKey = `${refReg.type}:${normaliseName(coerced.value)}`
        if (!mentionsByKey.has(refMentionKey)) {
          mentionsByKey.set(refMentionKey, {
            reg: refReg,
            mention: { name: coerced.value, aliases: [] },
          })
        }
      }
      checked.push({
        candidate,
        reg,
        mentionKey,
        key,
        value: coerced.value,
        vKey: valueKey(coerced.value),
        validity,
        located,
        refMentionKey,
        refType: refMentionKey ? refReg?.type : undefined,
      })
    }

    // 2. What each mention is: the run's cache, a link, or a staging entity still to be written.
    const entityOf = new Map<string, SectionEntity>()
    const planned = new Map<string, { plan: PlannedEntity; review: boolean }>()
    for (const [mentionKey, { reg, mention }] of mentionsByKey) {
      const cached = entityCache.get(mentionKey)
      if (cached) {
        entityOf.set(mentionKey, cached)
        continue
      }
      const plan = await planMention(resolveCtx, reg, mention)
      if ('link' in plan) {
        entityOf.set(mentionKey, plan.link)
        cacheEntity(entityCache, reg.type, [mention.name, ...mention.aliases], plan.link)
      } else {
        planned.set(mentionKey, { plan: plan.create, review: true })
        entityOf.set(mentionKey, { kind: 'staging', id: `pending:${mentionKey}`, pending: true })
      }
    }

    // 3. A planned entity with known ones nearby: ask whether it is one of them.
    const ask = [...planned].filter(([, p]) => p.plan.nearby.length > 0)
    if (ask.length > 0 && (await judge.engine())) {
      const questions = await entityQuestions(db, tenantId, doc.title, ask, checked, section)
      const answers = await judge.entities(questions.map(q => q.question))
      for (const [i, answer] of answers.entries()) {
        const q = questions[i]
        if (!q || !answer) continue
        const entry = planned.get(q.mentionKey)
        if (!entry) continue
        if (answer.answer === 'new') {
          // Confidently none of them: a new entity, and no "is this the same as …?" to ask.
          entry.review = false
          report.judged.entitiesNew += 1
          continue
        }
        const candidate = entry.plan.nearby.find(c => c.id === answer.answer)
        if (!candidate) continue
        const linked = await linkPlanned(resolveCtx, entry.plan, candidate)
        planned.delete(q.mentionKey)
        entityOf.set(q.mentionKey, linked)
        cacheEntity(entityCache, entry.plan.type, entry.plan.names, linked)
        report.judged.entitiesLinked += 1
      }
    }

    // 4. A section that gives one entity two values for one key over one window misread itself.
    const slotOf = (c: CheckedFact) => {
      const e = entityOf.get(c.mentionKey) as SectionEntity
      return `${e.kind}:${e.id}:${c.key}:${c.validity.validFrom?.getTime() ?? ''}:${c.validity.validTo?.getTime() ?? ''}`
    }
    /** What a fact compares by inside the section: its value, or the entity its value names. */
    const sectionKeyOf = (c: CheckedFact) => {
      if (!c.refMentionKey) return c.vKey
      const named = entityOf.get(c.refMentionKey) as SectionEntity
      return `e:${named.kind}:${named.id}`
    }
    const valuesPerSlot = new Map<string, Set<string>>()
    for (const c of checked) {
      const slot = slotOf(c)
      valuesPerSlot.set(slot, (valuesPerSlot.get(slot) ?? new Set()).add(sectionKeyOf(c)))
    }
    const surviving = checked.filter(c => {
      if ((valuesPerSlot.get(slotOf(c))?.size ?? 0) > 1) {
        drop('ambiguous')
        return false
      }
      return true
    })

    // 5. Write the planned entities that still have a fact — an ambiguous reading leaves none.
    for (const mentionKey of surviving.flatMap(c => [c.mentionKey, c.refMentionKey ?? []].flat())) {
      const current = entityOf.get(mentionKey) as SectionEntity
      if (!('pending' in current)) continue
      const entry = planned.get(mentionKey)
      if (!entry) continue
      const entity = await commitPlanned(resolveCtx, entry.plan, { review: entry.review })
      planned.delete(mentionKey)
      entityOf.set(mentionKey, entity)
      cacheEntity(entityCache, entry.plan.type, entry.plan.names, entity)
      created.add(entity.id)
      report.entitiesCreated += 1
      if (entity.possibleMatch) report.possibleMatches += 1
    }

    const prepared: PreparedFact[] = surviving.map(c => {
      const named = c.refMentionKey ? (entityOf.get(c.refMentionKey) as ResolvedEntity) : undefined
      const valueRef =
        named && c.refType ? valueRefOf({ kind: named.kind, type: c.refType, id: named.id }) : null
      return {
        ...c,
        entity: entityOf.get(c.mentionKey) as ResolvedEntity,
        valueRef,
        vKey: valueRef ? `e:${valueRef}` : c.vKey,
      }
    })

    // 6. Where a fact would disagree with one already held, ask whether the two values agree.
    await judgeValues(db, tenantId, judge, prepared, doc.title, section, report)

    for (const {
      candidate,
      reg,
      entity,
      key,
      value,
      vKey,
      valueRef,
      validity,
      located,
    } of prepared) {
      const dedupe = `${entity.kind}:${entity.id}:${key}:${vKey}`
      if (written.has(dedupe)) {
        drop('duplicate')
        continue
      }
      written.add(dedupe)
      const chunk = chunkAt(section, located.start, located.end)
      const source = {
        chunkId: chunk?.id ?? null,
        charStart: section.offset === null ? null : section.offset + located.start,
        charEnd: section.offset === null ? null : section.offset + located.end,
        quote: stripControlChars(section.text.slice(located.start, located.end)),
        confidence: clamp01(candidate.confidence),
      }
      const slot = {
        entityKind: entity.kind,
        entityType: reg.type,
        entityId: entity.id,
        key,
        valueKey: vKey,
        ...validity,
      }
      // The same value, or one a decision model judged the same ("per call-out" re-read as "per
      // visit"): the person's decision carries over.
      const prior =
        matchDecided(decided, kept, slot) ??
        (decided.some(d => d.key === key && d.entityId === entity.id && !kept.has(d.id))
          ? matchDecided(
              decided,
              kept,
              slot,
              (
                await loadJudged(
                  db,
                  tenantId,
                  { kind: entity.kind, type: reg.type, id: entity.id },
                  key
                )
              ).judged
            )
          : undefined)
      if (prior) {
        // A person already settled this exact fact: keep their decision, refresh its citation.
        kept.add(prior.id)
        await keepDecidedFact(db, tenantId, prior, {
          ...source,
          ...validity,
          value,
          valueRef,
          valueText: valueText(value),
          sourceKind,
          observedAt: documentDate,
          reviewerUserId,
          visibility,
        })
        report.factIds.push(prior.id)
        report.decisionsKept += 1
        continue
      }
      const id = await writeFact(db, {
        tenantId,
        entityKind: entity.kind,
        entityType: reg.type,
        entityId: entity.id,
        key,
        value,
        valueRef,
        valueText: valueText(value),
        valueKey: vKey,
        documentId,
        ...source,
        sourceKind,
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
      decisionsKept: report.decisionsKept,
    },
    'knowledge.extract: done'
  )
  return finish()
}

// ── Asking the decision model ─────────────────────────────────────────────────────────────────

/** Facts shown per entity when a judge compares one with a mention. */
const JUDGE_FACTS_PER_ENTITY = 8

const refKey = (kind: string, type: string, id: string) => `${kind}:${type}:${id}`

/** `key = value` lines of the answerable facts held for each entity, a few each. */
async function factLinesOf(
  db: Database,
  tenantId: string,
  refs: readonly { kind: 'domain' | 'staging'; type: string; id: string }[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (refs.length === 0) return out
  const rows = await db
    .select({
      kind: knowledgeFacts.entityKind,
      type: knowledgeFacts.entityType,
      id: knowledgeFacts.entityId,
      key: knowledgeFacts.key,
      valueText: knowledgeFacts.valueText,
    })
    .from(knowledgeFacts)
    .innerJoin(documents, factDocument(tenantId))
    .where(
      and(
        eq(knowledgeFacts.tenantId, tenantId),
        inArray(knowledgeFacts.state, [...ANSWERABLE_FACT_STATES]),
        inArray(
          knowledgeFacts.entityId,
          refs.map(r => r.id)
        ),
        visibleDocuments(promptScope(tenantId))
      )
    )
    .orderBy(asc(knowledgeFacts.observedAt))
  for (const r of rows) {
    const k = refKey(r.kind, r.type, r.id)
    const list = out.get(k) ?? []
    const line = `${r.key} = ${r.valueText}`
    if (!list.includes(line) && list.length < JUDGE_FACTS_PER_ENTITY) list.push(line)
    out.set(k, list)
  }
  return out
}

/** The entity questions for a section's planned mentions that have known entities nearby. */
async function entityQuestions(
  db: Database,
  tenantId: string,
  documentTitle: string,
  ask: readonly [string, { plan: PlannedEntity }][],
  checked: readonly CheckedFact[],
  section: Section
): Promise<{ mentionKey: string; question: EntityQuestion }[]> {
  const refs = ask.flatMap(([, { plan }]) =>
    plan.nearby.map(c => ({ kind: c.kind, type: plan.type, id: c.id }))
  )
  const facts = await factLinesOf(db, tenantId, refs)
  const stagingIds = refs.filter(r => r.kind === 'staging').map(r => r.id)
  const aliasRows =
    stagingIds.length === 0
      ? []
      : await db
          .select({ id: knowledgeEntities.id, aliases: knowledgeEntities.aliases })
          .from(knowledgeEntities)
          .where(
            and(eq(knowledgeEntities.tenantId, tenantId), inArray(knowledgeEntities.id, stagingIds))
          )
  const aliases = new Map(aliasRows.map(r => [r.id, r.aliases]))
  return ask.map(([mentionKey, { plan }]) => {
    const own = checked.filter(c => c.mentionKey === mentionKey)
    const reg = own[0]?.reg
    return {
      mentionKey,
      question: {
        type: plan.type,
        label: reg?.label ?? plan.type,
        mention: {
          names: plan.names,
          facts: own.map(c => `${c.key} = ${valueText(c.value)}`),
          quotes: [
            ...new Set(own.map(c => section.text.slice(c.located.start, c.located.end))),
          ].slice(0, 6),
          document: documentTitle,
        },
        candidates: plan.nearby.map(c => ({
          id: c.id,
          name: c.label,
          aliases: aliases.get(c.id) ?? [],
          facts: facts.get(refKey(c.kind, plan.type, c.id)) ?? [],
        })),
      },
    }
  })
}

/** A key's `.describe()`, for the judge — what the value means. */
function keyMeaning(reg: EntityTypeRegistration, key: string): string | undefined {
  const schema = entityFactsJsonSchema(reg) as {
    properties?: Record<string, { description?: string }>
  }
  return schema.properties?.[key]?.description
}

/**
 * For each fact about to be written onto an entity that already holds facts for its key: the held
 * values that DIFFER from it over an overlapping window and that no verdict covers yet are asked
 * about (`judge.values`), and every answer is stored (`knowledge_value_judgements`) for
 * `writeFact`'s `decideFactState` to read. No engine, or a failed call: nothing is stored, and the
 * literal rule decides.
 */
async function judgeValues(
  db: Database,
  tenantId: string,
  judge: KnowledgeJudge,
  prepared: readonly PreparedFact[],
  documentTitle: string,
  section: Section,
  report: ExtractionReport
): Promise<void> {
  const existing = prepared.filter(p => !p.entity.created)
  if (existing.length === 0) return
  interface Ask {
    ref: { kind: 'domain' | 'staging'; type: string; id: string }
    key: string
    a: string
    b: string
    question: ValueQuestion
  }
  const asks: Ask[] = []
  const queued = new Set<string>()
  for (const p of existing) {
    const ref = { kind: p.entity.kind, type: p.reg.type, id: p.entity.id }
    const held = await db
      .select({
        value: knowledgeFacts.value,
        valueRef: knowledgeFacts.valueRef,
        valueText: knowledgeFacts.valueText,
        quote: knowledgeFacts.quote,
        validFrom: knowledgeFacts.validFrom,
        validTo: knowledgeFacts.validTo,
        title: documents.title,
      })
      .from(knowledgeFacts)
      .innerJoin(documents, factDocument(tenantId))
      .where(
        and(
          eq(knowledgeFacts.tenantId, tenantId),
          eq(knowledgeFacts.entityKind, ref.kind),
          eq(knowledgeFacts.entityType, ref.type),
          eq(knowledgeFacts.entityId, ref.id),
          eq(knowledgeFacts.key, p.key),
          inArray(knowledgeFacts.state, [...ANSWERABLE_FACT_STATES]),
          visibleDocuments(promptScope(tenantId))
        )
      )
    if (held.length === 0) continue
    const { asked } = await loadJudged(db, tenantId, ref, p.key)
    // Facts that name an entity compare by it; whether two named entities are one is the
    // entity question, asked when the name was resolved.
    if (p.valueRef) continue
    for (const h of held) {
      const hKey = factCompareKey(h)
      if (hKey === p.vKey || h.valueRef) continue
      if (windowOrder(h, p.validity) !== 0) continue
      const id = `${refKey(ref.kind, ref.type, ref.id)}:${p.key}:${judgedPairId(hKey, p.vKey)}`
      if (asked.has(judgedPairId(hKey, p.vKey)) || queued.has(id)) continue
      queued.add(id)
      asks.push({
        ref,
        key: p.key,
        a: hKey,
        b: p.vKey,
        question: {
          entity: { type: ref.type, label: p.reg.label, name: p.entity.name },
          key: p.key,
          meaning: keyMeaning(p.reg, p.key),
          a: { value: h.valueText, quote: h.quote, document: h.title },
          b: {
            value: valueText(p.value),
            quote: section.text.slice(p.located.start, p.located.end),
            document: documentTitle,
          },
        },
      })
    }
  }
  if (asks.length === 0) return
  const engine = await judge.engine()
  if (!engine) return
  const answers = await judge.values(asks.map(a => a.question))
  for (const [i, answer] of answers.entries()) {
    const a = asks[i]
    if (!a || answer === undefined) continue
    report.judged.valuePairs += 1
    if (answer) report.judged.valuesAgreed += 1
    await storeJudgements(db, tenantId, a.ref, a.key, [
      { a: a.a, b: a.b, judgement: answer, method: engine.method, model: engine.model },
    ])
  }
}

/**
 * Refresh a kept decided fact from the new reading — its citation, confidence, document date and
 * validity — without touching its decision (`state`, `confirmed_*`, `conflicts_with`). A
 * confirmed fact whose validity moved has its key decided again (`recomputeKey`), since a window
 * is what tells a change over time from a disagreement; a rejected one is history either way.
 */
async function keepDecidedFact(
  db: Database,
  tenantId: string,
  prior: DecidedFact,
  next: Omit<
    FactToWrite,
    'tenantId' | 'entityKind' | 'entityType' | 'entityId' | 'key' | 'valueKey' | 'documentId'
  >
): Promise<void> {
  await db.transaction(async tx => {
    await tx
      .update(knowledgeFacts)
      .set({ ...next, updatedAt: new Date() })
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, prior.id)))
    const moved =
      !sameTime(prior.validFrom, next.validFrom) || !sameTime(prior.validTo, next.validTo)
    if (moved && prior.state !== 'rejected') {
      await recomputeKey(
        tx,
        tenantId,
        { kind: prior.entityKind, type: prior.entityType, id: prior.entityId },
        prior.key
      )
    }
  })
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
  valueRef: string | null
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
        valueRef: knowledgeFacts.valueRef,
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
      valueKey: factCompareKey(r),
      validFrom: r.validFrom,
      validTo: r.validTo,
    }))
    const { judged } = await loadJudged(
      tx,
      fact.tenantId,
      { kind: fact.entityKind, type: fact.entityType, id: fact.entityId },
      fact.key
    )
    const decision = decideFactState(
      {
        valueKey: fact.valueKey,
        confidence: fact.confidence,
        validFrom: fact.validFrom,
        validTo: fact.validTo,
      },
      held,
      judged
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
