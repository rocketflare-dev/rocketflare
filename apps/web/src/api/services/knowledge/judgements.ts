/**
 * The stored answers of `judge.ts`'s value questions (`knowledge_value_judgements`): read as a
 * `JudgedPair` by everything that decides a fact's state (`writeFact`, `recomputeKey`), written
 * once per pair, and moved with the facts when an entity is merged or promoted. Every query names
 * the tenant.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { knowledgeValueJudgements, type ValueVerdict } from '../../../db/schema'
import type { EntityRef } from './facts-read'
import type { Judgement } from './judge'
import type { JudgedPair } from './state'

const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])
const pairId = (a: string, b: string) => ordered(a, b).join('\u0000')

const refWhere = (tenantId: string, ref: EntityRef) =>
  and(
    eq(knowledgeValueJudgements.tenantId, tenantId),
    eq(knowledgeValueJudgements.entityKind, ref.kind),
    eq(knowledgeValueJudgements.entityType, ref.type),
    eq(knowledgeValueJudgements.entityId, ref.id)
  )

/** Every stored verdict for one entity and key, as a lookup (`different` and unknown → undefined). */
export async function loadJudged(
  db: Database,
  tenantId: string,
  ref: EntityRef,
  key: string
): Promise<{ judged: JudgedPair; asked: Set<string> }> {
  const rows = await db
    .select({
      a: knowledgeValueJudgements.valueA,
      b: knowledgeValueJudgements.valueB,
      verdict: knowledgeValueJudgements.verdict,
    })
    .from(knowledgeValueJudgements)
    .where(and(refWhere(tenantId, ref), eq(knowledgeValueJudgements.key, key)))
  const verdicts = new Map<string, ValueVerdict>()
  for (const r of rows) verdicts.set(pairId(r.a, r.b), r.verdict)
  return {
    judged: (a, b) => {
      const v = verdicts.get(pairId(a, b))
      return v === 'same' || v === 'compatible' ? v : undefined
    },
    asked: new Set(verdicts.keys()),
  }
}

/** The id `loadJudged().asked` holds for a pair. */
export { pairId as judgedPairId }

export interface StoredJudgement {
  a: string
  b: string
  /** null: the model was unsure (or failed) — stored as `different`, the literal rule. */
  judgement: Judgement<'same' | 'compatible'> | null
  method: Judgement<string>['method']
  model: string
}

/** Store one verdict per pair; a pair already stored keeps its first answer. */
export async function storeJudgements(
  db: Database,
  tenantId: string,
  ref: EntityRef,
  key: string,
  entries: readonly StoredJudgement[]
): Promise<void> {
  const values = entries
    .filter(e => e.a !== e.b)
    .map(e => {
      const [valueA, valueB] = ordered(e.a, e.b)
      return {
        tenantId,
        entityKind: ref.kind,
        entityType: ref.type,
        entityId: ref.id,
        key,
        valueA,
        valueB,
        verdict: (e.judgement?.answer ?? 'different') as ValueVerdict,
        confidence: e.judgement?.confidence ?? 0,
        method: e.judgement?.method ?? e.method,
        model: e.judgement?.model ?? e.model,
      }
    })
  if (values.length === 0) return
  await db.insert(knowledgeValueJudgements).values(values).onConflictDoNothing()
}

/**
 * Move `from`'s verdicts to `to` (a merge or a promotion): copied where `to` has no verdict for
 * the pair yet, then deleted from `from`.
 */
export async function moveJudgements(
  tx: Database,
  tenantId: string,
  from: EntityRef,
  to: EntityRef
): Promise<void> {
  const rows = await tx.select().from(knowledgeValueJudgements).where(refWhere(tenantId, from))
  if (rows.length === 0) return
  await tx
    .insert(knowledgeValueJudgements)
    .values(
      rows.map(({ id: _id, createdAt: _c, updatedAt: _u, ...r }) => ({
        ...r,
        entityKind: to.kind,
        entityType: to.type,
        entityId: to.id,
      }))
    )
    .onConflictDoNothing()
  await tx.delete(knowledgeValueJudgements).where(
    and(
      eq(knowledgeValueJudgements.tenantId, tenantId),
      inArray(
        knowledgeValueJudgements.id,
        rows.map(r => r.id)
      )
    )
  )
}

/** For tests and the eval: how many verdicts a tenant holds, by verdict. */
export async function judgementCounts(
  db: Database,
  tenantId: string
): Promise<Record<ValueVerdict, number>> {
  const rows = await db
    .select({ verdict: knowledgeValueJudgements.verdict, n: sql<number>`count(*)::int` })
    .from(knowledgeValueJudgements)
    .where(eq(knowledgeValueJudgements.tenantId, tenantId))
    .groupBy(knowledgeValueJudgements.verdict)
  const out: Record<ValueVerdict, number> = { same: 0, compatible: 0, different: 0 }
  for (const r of rows) out[r.verdict] = Number(r.n)
  return out
}
