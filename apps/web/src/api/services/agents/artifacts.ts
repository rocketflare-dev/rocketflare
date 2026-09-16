/**
 * `agent_run_artifacts` — what a run PRODUCED that a person opens (issue #17): a draft email, the
 * table of rows it is about to change, the document it wrote.
 *
 * **`key` is an UPSERT key, not an identity.** A redrafted artifact replaces itself under
 * `(run_id, key)`, which is exactly why this is a table and a steering note is an event row
 * (decision 4): an artifact is mutable, queried across runs and outlives the run, and an
 * append-only positional log expresses none of those.
 *
 * What goes in `agent_run_events` is a THIN `artifact` row — `{ artifactId, key, kind, title }` —
 * so the timeline records WHERE it appeared while the table records what it is. The event is
 * written by the runtime (`ctx.artifact`), not here, because only the runtime holds the emitter.
 */
import type { AgentArtifact, AgentArtifactInput } from '@rocketflare/shared/ai/artifacts'
import { agentArtifactInputSchema } from '@rocketflare/shared/ai/artifacts'
import { and, asc, eq } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type AgentRunArtifactRow, agentRunArtifacts } from '../../../db/schema'
import { ValidationError } from '../../utils/core/errors'

export function toAgentArtifact(row: AgentRunArtifactRow): AgentArtifact {
  return {
    id: row.id,
    tenantId: row.tenantId,
    runId: row.runId,
    key: row.key,
    kind: row.kind,
    title: row.title,
    description: row.description,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Store (or replace) one artifact of a run. Validated against the shared contract HERE rather than
 * at the route, because the writer is an agent and the caps that matter — 100 000 markdown
 * characters, 1 000 table rows — are the ones that stop a jsonb column growing without bound.
 */
export async function upsertArtifact(
  db: Database,
  tenantId: string,
  runId: string,
  input: AgentArtifactInput
): Promise<AgentRunArtifactRow> {
  const parsed = agentArtifactInputSchema.safeParse(input)
  if (!parsed.success) throw new ValidationError(parsed.error.issues, 'Invalid agent artifact')
  const [row] = await db
    .insert(agentRunArtifacts)
    .values({
      tenantId,
      runId,
      key: parsed.data.key,
      kind: parsed.data.data.kind,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      data: parsed.data.data,
    })
    .onConflictDoUpdate({
      target: [agentRunArtifacts.runId, agentRunArtifacts.key],
      set: {
        kind: parsed.data.data.kind,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        data: parsed.data.data,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error('agent_run_artifacts: upsert returned no row')
  return row
}

/** Everything this run produced, oldest first. */
export function listArtifacts(
  db: Database,
  tenantId: string,
  runId: string
): Promise<AgentRunArtifactRow[]> {
  return db
    .select()
    .from(agentRunArtifacts)
    .where(and(eq(agentRunArtifacts.tenantId, tenantId), eq(agentRunArtifacts.runId, runId)))
    .orderBy(asc(agentRunArtifacts.createdAt))
}
