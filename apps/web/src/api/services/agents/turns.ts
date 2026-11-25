/**
 * The tool loop's journal over `agent_run_turns` — `ctx.journal`, handed to `runToolLoop` as
 * `journal`. The loop decides WHAT is served and recorded (`services/ai/agent-loop.ts`, "The turn
 * journal"); this file only stores and reads it, one loop at a time:
 *
 * - `open(key)` claims the loop key for this attempt (a second loop under it throws
 *   `EffectKeyConflictError`) and loads everything recorded under it in ONE query, so serving a
 *   turn or a result is a map lookup, not a round trip.
 * - A model turn is upserted on `(run_id, loop_key, turn)`: a turn re-asked because its transcript
 *   changed replaces the stale record.
 * - A tool call is `started` (side-effect handlers only) → `settled`, on `(run_id, loop_key,
 *   tool_call_id)`; `forgetToolCall` drops a `started` marker whose handler asked a person.
 *
 * Writes are awaited — a result the loop has served the model must already be on disk, or the
 * retry that matters most (the one after a crash) would run the tool again.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AgentRunTurnContent, type AgentRunTurnRow, agentRunTurns } from '../../../db/schema'
import {
  parseRecordedModelTurn,
  type RecordedModelTurn,
  type RecordedToolCall,
  type ToolLoopJournal,
  type ToolLoopRecord,
} from '../ai/agent-loop'
import { attemptKeys } from './keys'

/** The rows of one loop, as lookups. Shared with replay, which reads the same rows. */
export interface LoopRows {
  models: Map<number, RecordedModelTurn>
  tools: Map<string, RecordedToolCall>
}

export function loopRowsOf(rows: readonly AgentRunTurnRow[]): LoopRows {
  const models = new Map<number, RecordedModelTurn>()
  const tools = new Map<string, RecordedToolCall>()
  for (const row of rows) {
    if (row.role === 'model') {
      const turn = parseRecordedModelTurn(stored(row.content, 'model'), row)
      if (turn) models.set(row.turn, turn)
    } else if (row.toolCallId) {
      const content = stored(row.content, 'tool')
      if (row.status === 'started') tools.set(row.toolCallId, { status: 'started' })
      else if (content) {
        tools.set(row.toolCallId, {
          status: 'settled',
          text: content.text,
          isError: content.isError,
        })
      }
    }
  }
  return { models, tools }
}

function stored<K extends AgentRunTurnContent['kind']>(
  content: AgentRunTurnContent | null,
  kind: K
): Extract<AgentRunTurnContent, { kind: K }> | null {
  if (!content || content.kind !== kind) return null
  if (kind === 'tool') {
    const tool = content as Extract<AgentRunTurnContent, { kind: 'tool' }>
    if (typeof tool.text !== 'string' || typeof tool.isError !== 'boolean') return null
  }
  return content as Extract<AgentRunTurnContent, { kind: K }>
}

/** Every recorded row of one run, grouped by loop — replay's read. */
export async function loadRunTurns(
  db: Database,
  tenantId: string,
  runId: string
): Promise<Map<string, LoopRows>> {
  const rows = await db
    .select()
    .from(agentRunTurns)
    .where(and(eq(agentRunTurns.tenantId, tenantId), eq(agentRunTurns.runId, runId)))
  return groupRunTurns(rows)
}

/** A run's journal rows, by loop key — what `loadRunTurns` reads, from rows already in hand. */
export function groupRunTurns(rows: readonly AgentRunTurnRow[]): Map<string, LoopRows> {
  const byLoop = new Map<string, AgentRunTurnRow[]>()
  for (const row of rows) byLoop.set(row.loopKey, [...(byLoop.get(row.loopKey) ?? []), row])
  return new Map([...byLoop].map(([key, loopRows]) => [key, loopRowsOf(loopRows)]))
}

/** The runtime's journal for one attempt of one run. */
export function createTurnJournal(db: Database, tenantId: string, runId: string): ToolLoopJournal {
  const keys = attemptKeys('tool loop')
  return {
    async open(loopKey) {
      keys.claim(loopKey)
      const rows = await db
        .select()
        .from(agentRunTurns)
        .where(
          and(
            eq(agentRunTurns.tenantId, tenantId),
            eq(agentRunTurns.runId, runId),
            eq(agentRunTurns.loopKey, loopKey)
          )
        )
      const { models, tools } = loopRowsOf(rows)
      // Without `tenantId`: each insert names it itself, where the tenant-scope check reads it.
      const toolRow = (turn: number, toolCallId: string, toolName: string) => ({
        runId,
        loopKey,
        turn,
        role: 'tool' as const,
        toolCallId,
        toolName,
      })
      const record: ToolLoopRecord = {
        reemitServed: false,
        modelTurn: turn => models.get(turn) ?? null,
        toolCall: toolCallId => tools.get(toolCallId) ?? null,
        async recordModelTurn(turn, recorded) {
          const content: AgentRunTurnContent = {
            kind: 'model',
            content: recorded.content,
            stopReason: recorded.stopReason,
            usage: recorded.usage,
            injected: recorded.injected,
          }
          await db
            .insert(agentRunTurns)
            .values({
              tenantId,
              runId,
              loopKey,
              turn,
              role: 'model',
              content,
              requestHash: recorded.requestHash,
              systemHash: recorded.systemHash,
            })
            .onConflictDoUpdate({
              target: [agentRunTurns.runId, agentRunTurns.loopKey, agentRunTurns.turn],
              targetWhere: sql`role = 'model'`,
              set: {
                content,
                requestHash: recorded.requestHash,
                systemHash: recorded.systemHash,
                updatedAt: new Date(),
              },
            })
          models.set(turn, recorded)
        },
        async startToolCall(turn, toolCallId, toolName) {
          await db
            .insert(agentRunTurns)
            .values({ tenantId, ...toolRow(turn, toolCallId, toolName), status: 'started' })
            .onConflictDoNothing()
          tools.set(toolCallId, { status: 'started' })
        },
        async settleToolCall(turn, toolCallId, toolName, result) {
          const content: AgentRunTurnContent = {
            kind: 'tool',
            text: result.text,
            isError: result.isError,
          }
          await db
            .insert(agentRunTurns)
            .values({
              tenantId,
              ...toolRow(turn, toolCallId, toolName),
              status: 'settled',
              content,
            })
            .onConflictDoUpdate({
              target: [agentRunTurns.runId, agentRunTurns.loopKey, agentRunTurns.toolCallId],
              targetWhere: sql`role = 'tool'`,
              set: { status: 'settled', content, updatedAt: new Date() },
            })
          tools.set(toolCallId, { status: 'settled', ...result })
        },
        async forgetToolCall(toolCallId) {
          await db
            .delete(agentRunTurns)
            .where(
              and(
                eq(agentRunTurns.tenantId, tenantId),
                eq(agentRunTurns.runId, runId),
                eq(agentRunTurns.loopKey, loopKey),
                eq(agentRunTurns.toolCallId, toolCallId),
                eq(agentRunTurns.status, 'started')
              )
            )
          tools.delete(toolCallId)
        },
      }
      return record
    },
  }
}
