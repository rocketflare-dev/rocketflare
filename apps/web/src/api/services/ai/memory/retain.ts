/**
 * Memory retain (D36) — turn what a person wrote in chat into dated facts, entities and
 * supersessions, run by the `memory.retain` job after each chat turn.
 *
 * ```
 * conversation ─▶ user turns after the watermark ─▶ related existing facts (dense, own partition)
 *              ─▶ submit_memories (one structured call) ─▶ embed ─▶ ONE transaction:
 *                 CAS watermark → insert facts → upsert entities + links → invalidate superseded
 * ```
 *
 * The security rules live in WHAT this reads, so they are structural, not prompt-deep:
 *
 * - **Only the person's own turns are a source.** Assistant replies and tool results never reach
 *   the extraction call — so text the assistant read from a document (a group-restricted one, or
 *   one carrying instructions) cannot be laundered into memory that outlives the reader's access.
 * - **Everything happens inside one partition**: the conversation's owner, in its tenant. Related
 *   facts, supersessions and entities are all read and written under that owner, and a
 *   `supersedes` id the model invents outside it is dropped.
 * - **Off means never learned.** When the person (or the organisation) has memory off, the job
 *   advances the watermark without learning, so turning it back on later does not reach back into
 *   what was said while it was off. The first pass on a conversation starts at the turn that
 *   triggered it, never at the start of an old thread.
 *
 * Concurrency is the compare-and-set on `memory_retained_through_id`, inside the write
 * transaction: two deliveries produce one set of facts and one no-op.
 */
import {
  MEMORY_ENTITIES_MAX,
  MEMORY_ENTITY_NAME_MAX,
  MEMORY_FACTS_PER_RETAIN_MAX,
  MEMORY_KINDS,
  MEMORY_RETAIN_MIN_CHARS,
  MEMORY_TEXT_MAX_CHARS,
} from '@rocketflare/shared/ai/memory'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { AppConfig } from '../../../../config'
import type { Database } from '../../../../db/client'
import {
  type ConversationRow,
  conversations,
  type MessageRow,
  memories,
  memoryEntities,
  memoryEntityLinks,
  messages,
} from '../../../../db/schema'
import { traceEmbed } from '../../../observability/context'
import type { Tracer } from '../../../observability/tracer'
import { traceChatClient, withAgentTrace } from '../../../observability/tracing'
import type { Logger } from '../../../utils/core/logger'
import { resolvePrompt } from '../../prompts'
import { AiNotConfiguredError } from '../errors'
import { callStructuredTool } from '../kit'
import { resolveChat, resolveEmbeddings } from '../resolve'
import { vectorLiteral } from '../retrieval'
import type { AiEnv } from '../types'
import { recordUsage } from '../usage'
import { memoryEnabledFor } from './settings'
import { normaliseEntityName } from './store'

export const SUBMIT_MEMORIES_TOOL = 'submit_memories'
/** User turns one pass reads at most — a backlog is learned from its newest end. */
export const MEMORY_RETAIN_MAX_TURNS = 10
/** Characters of one user turn the extraction sees. */
export const MEMORY_RETAIN_TURN_MAX_CHARS = 4_000
/** Existing facts shown to the model as candidates to supersede or not to repeat. */
export const MEMORY_RELATED_FACTS = 15
/** Cosine similarity at or above which a new fact is the same as one already held. */
export const MEMORY_DUPLICATE_SIMILARITY = 0.95
/** Messages read back from the thread to find the watermark — far more than one turn adds. */
const MESSAGE_WINDOW = 60

const isoDate = z
  .string()
  .trim()
  .refine(v => !Number.isNaN(Date.parse(v)), 'Expected an ISO date')

export const submitMemoriesSchema = z.object({
  facts: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_CHARS),
        kind: z.enum(MEMORY_KINDS).optional(),
        occurredStart: isoDate.nullish(),
        occurredEnd: isoDate.nullish(),
        entities: z
          .array(z.string().trim().min(1).max(MEMORY_ENTITY_NAME_MAX))
          .max(MEMORY_ENTITIES_MAX)
          .optional(),
        supersedes: z.array(z.string()).max(10).optional(),
      })
    )
    .max(MEMORY_FACTS_PER_RETAIN_MAX)
    .describe('Facts worth remembering; an empty list when there are none'),
})
export type SubmitMemories = z.infer<typeof submitMemoriesSchema>
/** A fact with its optional fields settled — what the rest of the pass works with. */
interface ExtractedFact {
  text: string
  kind: (typeof MEMORY_KINDS)[number]
  occurredStart: string | null
  occurredEnd: string | null
  entities: string[]
  supersedes: string[]
}

export interface RetainDeps {
  db: Database
  cfg: AppConfig
  env: AiEnv
  logger: Logger
  tracer: Tracer
}

export type RetainOutcome =
  | { status: 'missing' | 'nothing_new' | 'too_little' | 'no_provider' | 'lost_race' }
  | { status: 'disabled'; skipped: number }
  | { status: 'retained'; created: number; superseded: number; duplicates: number }

/**
 * The user turns a pass should read: everything after the watermark, or — on a conversation's
 * first pass — from the turn that triggered it. Pure, so the boundary rules are unit-tested.
 */
export function pendingUserTurns(
  rows: Pick<MessageRow, 'id' | 'role'>[],
  watermark: string | null,
  triggeredBy: string | undefined
): { pending: number[]; through: number } | null {
  if (rows.length === 0) return null
  let start = 0
  if (watermark) {
    const at = rows.findIndex(r => r.id === watermark)
    // Not in the window: older than every row read, so everything read is new.
    start = at === -1 ? 0 : at + 1
  } else if (triggeredBy) {
    const at = rows.findIndex(r => r.id === triggeredBy)
    start = at === -1 ? rows.length : at
  } else {
    start = rows.length
  }
  if (start >= rows.length) return null
  const pending: number[] = []
  for (let i = start; i < rows.length; i++) if (rows[i]?.role === 'user') pending.push(i)
  return { pending: pending.slice(-MEMORY_RETAIN_MAX_TURNS), through: rows.length - 1 }
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

function formatDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

export async function retainConversation(
  deps: RetainDeps,
  input: { tenantId: string; conversationId: string; messageId?: string }
): Promise<RetainOutcome> {
  const { db, cfg, env, logger } = deps
  const { tenantId, conversationId } = input
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
    .limit(1)
  if (!conversation) return { status: 'missing' }

  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.tenantId, tenantId)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(MESSAGE_WINDOW)
  const rows = recent.reverse()
  const window = pendingUserTurns(rows, conversation.memoryRetainedThroughId, input.messageId)
  if (!window) return { status: 'nothing_new' }
  const through = rows[window.through] as MessageRow
  const turns = window.pending.map(i => rows[i] as MessageRow)

  if (!(await memoryEnabledFor(db, cfg, tenantId, conversation.userId))) {
    // Off means never learned: move past these turns so switching memory back on cannot reach
    // into them. A lost race here is harmless — the winner moved it at least as far.
    await advanceWatermark(db, conversation, through.id)
    return { status: 'disabled', skipped: turns.length }
  }
  const userText = turns.map(t => t.content).join('\n')
  // Too little to be worth a model call. The watermark stays, so these turns are read again with
  // the next ones — "I'm" + "the new Payments lead" is two turns and one fact.
  if (userText.trim().length < MEMORY_RETAIN_MIN_CHARS) return { status: 'too_little' }

  let chat: Awaited<ReturnType<typeof resolveChat>>
  let embeddings: Awaited<ReturnType<typeof resolveEmbeddings>>
  try {
    chat = await resolveChat(db, cfg, env, tenantId, { promptKey: 'memory-extraction' })
    embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
  } catch (err) {
    // No provider: nothing can be learned and no retry will change that. The watermark stays, so
    // the turns are learned once a provider exists — they were said with memory ON.
    if (err instanceof AiNotConfiguredError) {
      logger.warn({ conversationId }, 'memory.retain: no AI provider, skipping')
      return { status: 'no_provider' }
    }
    throw err
  }

  const ownerUserId = conversation.userId
  const partition = and(
    eq(memories.tenantId, tenantId),
    eq(memories.ownerUserId, ownerUserId),
    eq(memories.visibility, 'private'),
    isNull(memories.invalidatedAt)
  )

  return withAgentTrace(
    'memory.retain',
    {
      tracer: deps.tracer,
      tenantId,
      userId: ownerUserId,
      conversationId,
      kind: 'job',
      spanName: 'job memory.retain',
      tags: ['memory', 'retain'],
      metadata: { turns: turns.length, model: chat.model },
    },
    async trace => {
      const [probe] = await traceEmbed(embeddings, [userText], () =>
        embeddings.client.embed([userText.slice(0, 8_000)])
      )
      const related = probe
        ? await db.transaction(async tx => {
            await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
            return tx
              .select({
                id: memories.id,
                text: memories.text,
                mentionedAt: memories.mentionedAt,
                embedding: memories.embedding,
              })
              .from(memories)
              .where(and(eq(memories.tenantId, tenantId), partition))
              .orderBy(sql`${memories.embedding} <=> ${vectorLiteral(probe)}::vector`)
              .limit(MEMORY_RELATED_FACTS)
          })
        : []

      const system = await resolvePrompt(db, tenantId, 'memory-extraction', {
        appName: cfg.APP_NAME,
        tenantName: '',
      })
      const transcript = turns
        .map(
          t =>
            `[sent ${formatDay(t.createdAt)}]\n${t.content.slice(0, MEMORY_RETAIN_TURN_MAX_CHARS)}`
        )
        .join('\n\n')
      const known = related.length
        ? related.map(r => `- [${r.id}] ${r.text} (said ${formatDay(r.mentionedAt)})`).join('\n')
        : '(none yet)'
      const extracted = await callStructuredTool(
        traceChatClient(chat.client, trace, { provider: chat.provider }, deps.tracer),
        {
          model: chat.model,
          maxTokens: chat.maxOutputTokens,
          system,
          messages: [
            {
              role: 'user',
              content: `Facts already in memory:\n${known}\n\n---\n\nTheir messages:\n\n${transcript}`,
            },
          ],
          tool: {
            name: SUBMIT_MEMORIES_TOOL,
            description: 'Submit the facts worth remembering. Call exactly once.',
            schema: submitMemoriesSchema,
          },
          onUsage: usage =>
            void recordUsage(db, {
              tenantId,
              userId: ownerUserId,
              feature: 'memory:retain',
              provider: chat.provider,
              model: chat.model,
              usage,
            }).catch(err => logger.warn({ err }, 'memory.retain: usage write failed')),
        }
      )

      const relatedIds = new Set(related.map(r => r.id))
      const facts: ExtractedFact[] = extracted.facts.map(f => ({
        text: f.text,
        kind: f.kind ?? 'fact',
        occurredStart: f.occurredStart ?? null,
        occurredEnd: f.occurredEnd ?? null,
        entities: f.entities ?? [],
        // Only ids the model was SHOWN — never one it invented, and never outside the partition.
        supersedes: (f.supersedes ?? []).filter(id => relatedIds.has(id)),
      }))
      const vectors =
        facts.length > 0
          ? await traceEmbed(
              embeddings,
              facts.map(f => f.text),
              () => embeddings.client.embed(facts.map(f => f.text))
            )
          : []

      // Near-duplicates of what is already held — or of an earlier fact in this same batch — are
      // dropped, unless they supersede something (then they ARE the change).
      const kept: { fact: ExtractedFact; vector: number[] }[] = []
      let duplicates = 0
      facts.forEach((fact, i) => {
        const vector = vectors[i]
        if (!vector) return
        const seen = [
          ...related.filter(r => !fact.supersedes.includes(r.id)).map(r => r.embedding),
          ...kept.map(k => k.vector),
        ]
        if (seen.some(v => cosine(v, vector) >= MEMORY_DUPLICATE_SIMILARITY)) {
          duplicates += 1
          return
        }
        kept.push({ fact, vector })
      })

      const mentionedAt = turns[turns.length - 1]?.createdAt ?? new Date()
      const sourceMessageIds = turns.map(t => t.id)
      const outcome = await db.transaction(async tx => {
        const moved = await advanceWatermark(tx, conversation, through.id)
        if (!moved) return null
        let superseded = 0
        for (const { fact, vector } of kept) {
          const names = dedupeEntityNames(fact.entities)
          const [row] = await tx
            .insert(memories)
            .values({
              tenantId,
              ownerUserId,
              visibility: 'private',
              kind: fact.kind,
              text: fact.text,
              occurredStart: parseInstant(fact.occurredStart),
              occurredEnd: parseInstant(fact.occurredEnd),
              mentionedAt,
              embedding: vector,
              embeddingModel: embeddings.model,
              textSignals: names.map(n => n.name).join(' '),
              sourceConversationId: conversationId,
              sourceMessageIds,
            })
            .returning({ id: memories.id })
          if (!row) throw new Error('memories: insert returned no row')
          await linkEntities(tx, tenantId, ownerUserId, row.id, names, mentionedAt)
          if (fact.supersedes.length > 0) {
            const invalidated = await tx
              .update(memories)
              .set({ invalidatedAt: mentionedAt, supersededById: row.id })
              .where(and(partition, inArray(memories.id, fact.supersedes)))
              .returning({ id: memories.id })
            superseded += invalidated.length
          }
        }
        return { created: kept.length, superseded }
      })
      if (!outcome) {
        logger.info({ conversationId }, 'memory.retain: another run retained first, discarding')
        return { status: 'lost_race' } as const
      }
      logger.info({ conversationId, ...outcome, duplicates }, 'memory.retain: retained')
      return { status: 'retained', ...outcome, duplicates } as const
    }
  )
}

/** Compare-and-set on what this run read; false when another run moved it first. */
async function advanceWatermark(
  db: Database,
  conversation: ConversationRow,
  throughId: string
): Promise<boolean> {
  const moved = await db
    .update(conversations)
    .set({ memoryRetainedThroughId: throughId })
    .where(
      and(
        eq(conversations.id, conversation.id),
        eq(conversations.tenantId, conversation.tenantId),
        conversation.memoryRetainedThroughId === null
          ? isNull(conversations.memoryRetainedThroughId)
          : eq(conversations.memoryRetainedThroughId, conversation.memoryRetainedThroughId)
      )
    )
    .returning({ id: conversations.id })
  return moved.length > 0
}

function dedupeEntityNames(names: string[]): { name: string; normalised: string }[] {
  const out = new Map<string, string>()
  for (const name of names) {
    const normalised = normaliseEntityName(name)
    if (normalised.length < 2 || out.has(normalised)) continue
    out.set(normalised, name.trim())
  }
  return [...out].map(([normalised, name]) => ({ name, normalised }))
}

/** Upsert each entity in the owner's partition and link it to the fact. */
async function linkEntities(
  tx: Database,
  tenantId: string,
  ownerUserId: string,
  memoryId: string,
  names: { name: string; normalised: string }[],
  seenAt: Date
): Promise<void> {
  for (const { name, normalised } of names) {
    const [entity] = await tx
      .insert(memoryEntities)
      .values({
        tenantId,
        ownerUserId,
        name,
        normalisedName: normalised,
        mentionCount: 1,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      })
      .onConflictDoUpdate({
        target: [
          memoryEntities.tenantId,
          memoryEntities.ownerUserId,
          memoryEntities.normalisedName,
        ],
        set: {
          mentionCount: sql`${memoryEntities.mentionCount} + 1`,
          lastSeenAt: sql`greatest(${memoryEntities.lastSeenAt}, excluded.last_seen_at)`,
        },
      })
      .returning({ id: memoryEntities.id })
    if (!entity) continue
    await tx
      .insert(memoryEntityLinks)
      .values({ tenantId, memoryId, entityId: entity.id })
      .onConflictDoNothing()
  }
}
