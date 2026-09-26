/**
 * Thumbs feedback on AI answers (D33): `recordFeedback` upserts one person's vote on an assistant
 * message or an agent run, `withdrawFeedback` removes it, `listFeedback` is the admin promotion
 * queue and `myFeedback` answers "which of these did I already rate?" for the UI.
 *
 * **The rater must be able to read what they rate**, and that is checked here rather than trusted:
 * a message belongs to the rater's OWN conversation (another member's thread is 404, admins
 * included — D17), a run is the rater's own unless they are admin-level (D7). A foreign or unknown
 * id is a 404, never a 403, so an id cannot be probed.
 *
 * Every vote also lands in the rated answer's TRACE (D32) as a zero-length `feedback` span under the
 * trace's root, with `rocketflare.feedback.rating` on it — `rocketflare traces show <id>` prints
 * it, and a backend can join thumbs to the generation they judged. A span rather than an OTLP span
 * event because the local store has no events column and the recorder no events API; a finished
 * child span carries the same facts and every backend renders it. No root recorded (pruned, or
 * tracing produced nothing) → the vote is still stored, just not traced.
 */
import type {
  CreateFeedbackRequest,
  Feedback,
  FeedbackListQuery,
  FeedbackListResponse,
  FeedbackTarget,
} from '@rocketflare/shared/ai/evals'
import { paginationMeta } from '@rocketflare/shared/pagination'
import { and, count, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm'
import type { Database } from '../../db/client'
import {
  type AiFeedbackRow,
  agentRuns,
  aiFeedback,
  aiSpans,
  conversations,
  messages,
} from '../../db/schema'
import { ATTR } from '../observability/genai-attributes'
import { rootSpanIdForRun, traceIdForRun } from '../observability/trace-ids'
import type { Tracer } from '../observability/tracer'
import { NotFoundError } from '../utils/core/errors'

export interface FeedbackActor {
  tenantId: string
  userId: string
  /** Admin-level raters may rate any run in the tenant (they can read every run). */
  isAdmin: boolean
}

export function toFeedback(row: AiFeedbackRow): Feedback {
  return {
    id: row.id,
    target: row.target,
    targetId: row.targetId,
    rating: row.rating,
    comment: row.comment,
    userId: row.userId,
    traceId: row.traceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

interface RatedTarget {
  traceId: string | null
  /** The span the feedback span hangs under, when it is known without a lookup (a run's root). */
  rootSpanId: string | null
  runId?: string
  conversationId?: string
}

/** The rated row, or a 404 when this actor cannot read it. */
async function readableTarget(
  db: Database,
  actor: FeedbackActor,
  target: FeedbackTarget,
  targetId: string
): Promise<RatedTarget> {
  if (target === 'message') {
    const [row] = await db
      .select({ traceId: messages.traceId, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.tenantId, actor.tenantId),
          eq(messages.id, targetId),
          eq(messages.role, 'assistant'),
          eq(conversations.tenantId, actor.tenantId),
          // D17: a thread is its owner's — admins included — so only they can rate its answers.
          eq(conversations.userId, actor.userId)
        )
      )
      .limit(1)
    if (!row) throw new NotFoundError('Message not found', 'message_not_found')
    return { traceId: row.traceId, rootSpanId: null, conversationId: row.conversationId }
  }
  const run = await db.query.agentRuns.findFirst({
    columns: { id: true, traceId: true, requestedByUserId: true },
    where: and(eq(agentRuns.tenantId, actor.tenantId), eq(agentRuns.id, targetId)),
  })
  if (!run || (!actor.isAdmin && run.requestedByUserId !== actor.userId)) {
    throw new NotFoundError('Agent run not found', 'agent_run_not_found')
  }
  return {
    traceId: run.traceId ?? traceIdForRun(run.id),
    rootSpanId: rootSpanIdForRun(run.id),
    runId: run.id,
  }
}

/** The recorded root of a trace, tenant-scoped; null when it was never stored or has been pruned. */
async function rootSpanOf(db: Database, tenantId: string, traceId: string): Promise<string | null> {
  const [row] = await db
    .select({ spanId: aiSpans.spanId })
    .from(aiSpans)
    .where(
      and(
        eq(aiSpans.tenantId, tenantId),
        eq(aiSpans.traceId, traceId),
        isNull(aiSpans.parentSpanId)
      )
    )
    .limit(1)
  return row?.spanId ?? null
}

export async function recordFeedback(
  db: Database,
  tracer: Tracer,
  actor: FeedbackActor,
  input: CreateFeedbackRequest
): Promise<Feedback> {
  const rated = await readableTarget(db, actor, input.target, input.targetId)
  const comment = input.comment ? input.comment : null
  const [row] = await db
    .insert(aiFeedback)
    .values({
      tenantId: actor.tenantId,
      target: input.target,
      targetId: input.targetId,
      rating: input.rating,
      comment,
      userId: actor.userId,
      traceId: rated.traceId,
    })
    .onConflictDoUpdate({
      target: [aiFeedback.tenantId, aiFeedback.target, aiFeedback.targetId, aiFeedback.userId],
      set: { rating: input.rating, comment, traceId: rated.traceId, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error('ai_feedback: upsert returned no row')

  if (tracer.enabled && rated.traceId) {
    const parentSpanId = rated.rootSpanId ?? (await rootSpanOf(db, actor.tenantId, rated.traceId))
    if (parentSpanId) {
      const span = tracer.startTrace({
        name: 'feedback',
        spanName: 'feedback',
        kind: 'span',
        traceId: rated.traceId,
        parentSpanId,
        tenantId: actor.tenantId,
        userId: actor.userId,
        runId: rated.runId,
        conversationId: rated.conversationId,
        // The comment is what a person wrote about somebody's answer: content, so it goes where
        // `OBSERVABILITY_CAPTURE_CONTENT` governs it rather than into the attributes.
        input: comment ?? undefined,
      })
      span.setAttributes({
        [ATTR.feedbackRating]: input.rating,
        [ATTR.feedbackTarget]: input.target,
      })
      span.end()
    }
  }
  return toFeedback(row)
}

/** Withdraw this actor's vote. Idempotent: nothing to withdraw is still a success. */
export async function withdrawFeedback(
  db: Database,
  actor: FeedbackActor,
  target: FeedbackTarget,
  targetId: string
): Promise<void> {
  await db
    .delete(aiFeedback)
    .where(
      and(
        eq(aiFeedback.tenantId, actor.tenantId),
        eq(aiFeedback.target, target),
        eq(aiFeedback.targetId, targetId),
        eq(aiFeedback.userId, actor.userId)
      )
    )
}

/** This actor's own votes on the given targets — what the UI needs to draw the thumbs' state. */
export async function myFeedback(
  db: Database,
  actor: FeedbackActor,
  target: FeedbackTarget,
  targetIds: string[]
): Promise<Feedback[]> {
  if (targetIds.length === 0) return []
  const rows = await db
    .select()
    .from(aiFeedback)
    .where(
      and(
        eq(aiFeedback.tenantId, actor.tenantId),
        eq(aiFeedback.userId, actor.userId),
        eq(aiFeedback.target, target),
        inArray(aiFeedback.targetId, targetIds)
      )
    )
  return rows.map(toFeedback)
}

/** Every vote in the tenant, newest first — the admin promotion queue. */
export async function listFeedback(
  db: Database,
  tenantId: string,
  query: FeedbackListQuery
): Promise<FeedbackListResponse> {
  const filters: SQL[] = [eq(aiFeedback.tenantId, tenantId)]
  if (query.rating) filters.push(eq(aiFeedback.rating, query.rating === 'up' ? 1 : -1))
  if (query.target) filters.push(eq(aiFeedback.target, query.target))
  const where = and(...filters)
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(aiFeedback)
      .where(where)
      .orderBy(desc(aiFeedback.createdAt), desc(aiFeedback.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(aiFeedback).where(where),
  ])
  return {
    items: rows.map(toFeedback),
    pagination: paginationMeta(query.page, query.pageSize, Number(total?.value ?? 0)),
  }
}
