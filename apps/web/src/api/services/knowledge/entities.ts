/**
 * Entity resolution for extraction (D43): which entity a mention ("Harbour View Dental", "HVD")
 * is about. Per mention, in order — the registered `resolve` for a type with a domain table (or
 * the default trigram resolver over its label and alias columns), then the tenant's STAGING
 * entities of that type (trigram on name and aliases, plus the name embedding when an embedder
 * resolves), then a new staging entity.
 *
 * The decision, over every candidate scored in [0, 1]:
 *
 * - exactly one candidate at or above `LINK_THRESHOLD` (or exactly one exact name/alias match
 *   among several) → link to it, adding the mention's names to a staging entity's aliases;
 * - several at or above it, or the best in the review band [`REVIEW_THRESHOLD`, `LINK_THRESHOLD`)
 *   → a NEW staging entity carrying `possibleMatches` and `reviewerUserId` — the "is this the same
 *   as …?" review item. Never a guess, so two similar names never silently share facts;
 * - nothing in the band → a new staging entity, no review.
 *
 * The thresholds were read off `pg_trgm` `similarity()` over the kit fixture's names: a fuller form
 * of the same name scores ≥ 0.6 ("Riverside Lodge" / "Riverside Lodge Care Home" 0.62, "Harbour
 * View Dental" / "… Practice Ltd" 0.61), the planted confusable twin sits in the band ("Harbourside
 * Dental Lab" / "Harbour View Dental" 0.48), and unrelated names of one kind sit below it
 * ("Ashcombe Plant Hire" / "Ashcombe Business Park" 0.30). An embedding alone never LINKS — two
 * different companies in one trade embed close together — it can only raise a candidate into the
 * review band (cosine ≥ `EMBED_REVIEW_COSINE`).
 *
 * Every query names `scope.tenantId`, so a mention can only ever resolve inside its own tenant.
 */
import type { EntityKind, PossibleMatchCandidate } from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { knowledgeEntities } from '../../../db/schema'
import { fullAccessScope } from '../access'
import { resolverFor } from './resolve'
import type { EntityTypeRegistration } from './types'

/** At or above: one candidate links. */
export const LINK_THRESHOLD = 0.6
/** At or above (and below `LINK_THRESHOLD`): a possible match for a person to settle. */
export const REVIEW_THRESHOLD = 0.45
/** A name embedding this close puts a candidate in the review band, never above it. */
export const EMBED_REVIEW_COSINE = 0.9
/** Candidates kept per mention. */
const CANDIDATE_LIMIT = 5

export interface Mention {
  /** The name the model used for the entity. */
  name: string
  /** Other names the same passage uses for it. */
  aliases: readonly string[]
}

export interface ResolvedEntity {
  kind: EntityKind
  id: string
  /** The entity's own name (the domain row's label, or the staging entity's name). */
  name: string
  /** A new staging entity was written for this mention. */
  created: boolean
  /** The new entity carries a possible-match review item. */
  possibleMatch: boolean
}

export interface ResolveContext {
  db: Database
  tenantId: string
  /** Who is asked about a possible match. */
  reviewerUserId: string | null
  /** Embeds a name, or null without an embedder. */
  embedName?: ((name: string) => Promise<{ vector: number[]; model: string } | null>) | null
}

export const normaliseName = (name: string) =>
  name.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

function namesOf(mention: Mention): string[] {
  const out: string[] = []
  for (const n of [mention.name, ...mention.aliases]) {
    const clean = n.trim().replace(/\s+/g, ' ')
    if (clean && !out.some(o => normaliseName(o) === normaliseName(clean))) out.push(clean)
  }
  return out
}

const vectorLiteral = (vector: readonly number[]) => `[${vector.join(',')}]`

type Candidate = PossibleMatchCandidate & { exact: boolean }

function merge(into: Map<string, Candidate>, c: Candidate) {
  const key = `${c.kind}:${c.id}`
  const existing = into.get(key)
  if (!existing || c.score > existing.score || (c.exact && !existing.exact)) {
    into.set(key, { ...c, exact: c.exact || (existing?.exact ?? false) })
  }
}

/** Staging candidates by trigram over name + aliases, for every name of the mention. */
async function stagingCandidates(
  ctx: ResolveContext,
  type: string,
  names: readonly string[]
): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const name of names) {
    const score = sql<number>`greatest(similarity(${knowledgeEntities.name}, ${name}), coalesce((select max(similarity(a, ${name})) from unnest(${knowledgeEntities.aliases}) as a), 0))`
    const exact = sql<boolean>`(lower(${knowledgeEntities.name}) = lower(${name}) or exists (select 1 from unnest(${knowledgeEntities.aliases}) as a where lower(a) = lower(${name})))`
    const rows = await ctx.db
      .select({
        id: knowledgeEntities.id,
        name: knowledgeEntities.name,
        promotedType: knowledgeEntities.promotedType,
        promotedId: knowledgeEntities.promotedId,
        score: sql<number>`(${score})::float8`,
        exact,
      })
      .from(knowledgeEntities)
      .where(
        and(
          eq(knowledgeEntities.tenantId, ctx.tenantId),
          eq(knowledgeEntities.type, type),
          isNull(knowledgeEntities.mergedInto),
          sql`(${score} >= ${REVIEW_THRESHOLD} or ${exact})`
        )
      )
      .orderBy(sql`${score} desc`)
      .limit(CANDIDATE_LIMIT)
    for (const row of rows) {
      const promoted = row.promotedType === type && row.promotedId
      out.push({
        kind: promoted ? 'domain' : 'staging',
        id: promoted ? (row.promotedId as string) : row.id,
        label: row.name,
        score: row.exact ? 1 : Math.min(1, Math.max(0, Number(row.score))),
        exact: Boolean(row.exact),
      })
    }
  }
  return out
}

/** Staging candidates whose name embedding is close: scored into the review band at most. */
async function embeddingCandidates(
  ctx: ResolveContext,
  type: string,
  embedding: { vector: number[]; model: string }
): Promise<Candidate[]> {
  const literal = vectorLiteral(embedding.vector)
  const cosine = sql<number>`(1 - (${knowledgeEntities.embedding} <=> ${literal}::vector))::float8`
  const rows = await ctx.db
    .select({ id: knowledgeEntities.id, name: knowledgeEntities.name, cosine })
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.tenantId, ctx.tenantId),
        eq(knowledgeEntities.type, type),
        eq(knowledgeEntities.embeddingModel, embedding.model),
        isNull(knowledgeEntities.mergedInto),
        isNull(knowledgeEntities.promotedId)
      )
    )
    .orderBy(sql`${knowledgeEntities.embedding} <=> ${literal}::vector`)
    .limit(3)
  return rows
    .filter(r => Number(r.cosine) >= EMBED_REVIEW_COSINE)
    .map(r => ({
      kind: 'staging' as const,
      id: r.id,
      label: r.name,
      score: Math.min(Number(r.cosine), LINK_THRESHOLD - 0.01),
      exact: false,
    }))
}

async function addAliases(ctx: ResolveContext, id: string, names: readonly string[]) {
  const row = await ctx.db.query.knowledgeEntities.findFirst({
    columns: { name: true, aliases: true },
    where: and(eq(knowledgeEntities.id, id), eq(knowledgeEntities.tenantId, ctx.tenantId)),
  })
  if (!row) return
  const known = new Set([row.name, ...row.aliases].map(normaliseName))
  const fresh = names.filter(n => !known.has(normaliseName(n)))
  if (fresh.length === 0) return
  await ctx.db
    .update(knowledgeEntities)
    .set({ aliases: [...row.aliases, ...fresh] })
    .where(and(eq(knowledgeEntities.id, id), eq(knowledgeEntities.tenantId, ctx.tenantId)))
}

/** Pick from scored candidates — pure, the tests' seam. */
export function chooseCandidate(
  candidates: readonly Candidate[]
): { link: Candidate } | { review: Candidate[] } | { none: true } {
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  const above = ranked.filter(c => c.score >= LINK_THRESHOLD)
  const exact = above.filter(c => c.exact)
  if (exact.length === 1) return { link: exact[0] as Candidate }
  if (above.length === 1) return { link: above[0] as Candidate }
  const band = ranked.filter(c => c.score >= REVIEW_THRESHOLD)
  if (band.length > 0) return { review: band.slice(0, CANDIDATE_LIMIT) }
  return { none: true }
}

/**
 * Resolve one mention of a registered type to an entity, creating a staging entity when nothing
 * links. `cache` (per extraction run) answers a repeated mention without another lookup.
 */
export async function resolveMention(
  ctx: ResolveContext,
  reg: EntityTypeRegistration,
  mention: Mention,
  cache?: Map<string, ResolvedEntity>
): Promise<ResolvedEntity> {
  const names = namesOf(mention)
  const primary = names[0] ?? mention.name.trim()
  const cacheKey = `${reg.type}:${normaliseName(primary)}`
  const cached = cache?.get(cacheKey)
  if (cached) return cached

  const candidates = new Map<string, Candidate>()
  const resolver = resolverFor(reg)
  if (resolver) {
    const scope = { db: ctx.db, access: fullAccessScope(ctx.tenantId), limit: CANDIDATE_LIMIT }
    for (const name of names) {
      for (const c of await resolver(name, scope)) {
        merge(candidates, {
          kind: 'domain',
          id: c.id,
          label: c.label,
          score: c.score,
          exact: normaliseName(c.label) === normaliseName(name),
        })
      }
    }
  }
  for (const c of await stagingCandidates(ctx, reg.type, names)) merge(candidates, c)
  let choice = chooseCandidate([...candidates.values()])
  // The name embedding is computed only when the names alone do not link: it can add a review
  // candidate the spelling missed, and it is stored on the new staging entity for later mentions.
  let embedding: { vector: number[]; model: string } | null = null
  if (!('link' in choice) && ctx.embedName) {
    embedding = await ctx.embedName(primary).catch(() => null)
    if (embedding) {
      for (const c of await embeddingCandidates(ctx, reg.type, embedding)) merge(candidates, c)
      choice = chooseCandidate([...candidates.values()])
    }
  }

  let resolved: ResolvedEntity
  if ('link' in choice) {
    const { link } = choice
    if (link.kind === 'staging') await addAliases(ctx, link.id, names)
    resolved = {
      kind: link.kind,
      id: link.id,
      name: link.label,
      created: false,
      possibleMatch: false,
    }
  } else {
    const review = 'review' in choice ? choice.review : null
    const [row] = await ctx.db
      .insert(knowledgeEntities)
      .values({
        tenantId: ctx.tenantId,
        type: reg.type,
        name: primary,
        aliases: names.slice(1),
        embedding: embedding?.vector ?? null,
        embeddingModel: embedding?.model ?? null,
        possibleMatches: review
          ? review.map(({ exact: _exact, ...c }) => ({ ...c, score: round(c.score) }))
          : null,
        reviewerUserId: review ? ctx.reviewerUserId : null,
      })
      .returning({ id: knowledgeEntities.id, name: knowledgeEntities.name })
    if (!row) throw new Error('knowledge_entities: insert returned no row')
    resolved = {
      kind: 'staging',
      id: row.id,
      name: row.name,
      created: true,
      possibleMatch: review !== null,
    }
  }
  if (cache) for (const n of names) cache.set(`${reg.type}:${normaliseName(n)}`, resolved)
  return resolved
}

const round = (n: number) => Math.round(n * 1000) / 1000
