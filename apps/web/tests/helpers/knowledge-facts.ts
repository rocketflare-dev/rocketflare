/**
 * Seeding knowledge facts (D43) straight into the tables, for the review, card and tool tests:
 * a document (optionally restricted to groups), a staging entity, a fact on it. No extraction and
 * no model — the state each test needs is written as it is, so the test reads as the situation it
 * covers.
 */
import type {
  FactState,
  PossibleMatchCandidate,
  SourceKind,
} from '@rocketflare/shared/ai/knowledge-facts'
import { and, eq } from 'drizzle-orm'
import type { Database } from '@/db/client'
import { documentGroups, documents, knowledgeEntities, knowledgeFacts } from '@/db/schema'

export async function seedDocument(
  db: Database,
  input: {
    tenantId: string
    title: string
    ownerUserId?: string | null
    groupIds?: string[]
    createdAt?: Date
  }
) {
  const [doc] = await db
    .insert(documents)
    .values({
      tenantId: input.tenantId,
      title: input.title,
      contentType: 'text/plain',
      content: input.title,
      status: 'indexed',
      ownerUserId: input.ownerUserId ?? null,
      visibility: input.groupIds ? 'groups' : 'tenant',
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning()
  if (!doc) throw new Error('no document')
  for (const groupId of input.groupIds ?? []) {
    await db
      .insert(documentGroups)
      .values({ tenantId: input.tenantId, documentId: doc.id, groupId })
  }
  return doc
}

export async function seedEntity(
  db: Database,
  input: {
    tenantId: string
    name: string
    type?: string
    aliases?: string[]
    possibleMatches?: PossibleMatchCandidate[]
    reviewerUserId?: string | null
  }
) {
  const [entity] = await db
    .insert(knowledgeEntities)
    .values({
      tenantId: input.tenantId,
      type: input.type ?? 'customer',
      name: input.name,
      aliases: input.aliases ?? [],
      possibleMatches: input.possibleMatches ?? null,
      reviewerUserId: input.reviewerUserId ?? null,
    })
    .returning()
  if (!entity) throw new Error('no entity')
  return entity
}

export async function seedFact(
  db: Database,
  input: {
    tenantId: string
    entityId: string
    documentId: string
    key?: string
    value: unknown
    state?: FactState
    confidence?: number
    sourceKind?: SourceKind
    observedAt?: Date
    reviewerUserId?: string | null
    entityKind?: 'staging' | 'domain'
    entityType?: string
    validFrom?: Date | null
    validTo?: Date | null
    quote?: string
  }
) {
  const [fact] = await db
    .insert(knowledgeFacts)
    .values({
      tenantId: input.tenantId,
      entityKind: input.entityKind ?? 'staging',
      entityType: input.entityType ?? 'customer',
      entityId: input.entityId,
      key: input.key ?? 'monthly_fee_gbp',
      value: input.value,
      valueText: String(input.value),
      documentId: input.documentId,
      quote: input.quote ?? `The fee is ${String(input.value)}.`,
      sourceKind: input.sourceKind ?? 'upload',
      confidence: input.confidence ?? 0.9,
      state: input.state ?? 'accepted',
      observedAt: input.observedAt ?? new Date(),
      reviewerUserId: input.reviewerUserId ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
    })
    .returning()
  if (!fact) throw new Error('no fact')
  return fact
}

/** Link two seeded facts as a conflict, both `conflicting` (what extraction writes). */
export async function linkConflict(
  db: Database,
  tenantId: string,
  ...ids: string[]
): Promise<void> {
  for (const id of ids) {
    await db
      .update(knowledgeFacts)
      .set({ state: 'conflicting', conflictsWith: ids.filter(other => other !== id) })
      .where(and(eq(knowledgeFacts.tenantId, tenantId), eq(knowledgeFacts.id, id)))
  }
}
