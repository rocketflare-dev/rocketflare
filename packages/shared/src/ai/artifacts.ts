/**
 * Artifacts an agent run produces (issue #17): the things a person opens, not the prose the model
 * wrote. A draft email, a table of the rows it is about to change, the document it wrote.
 *
 * **An artifact is a TABLE row, not an event row**, and the asymmetry with a steering note is the
 * point (decision 4). An artifact is MUTABLE — a redrafted artifact must replace itself under
 * `(run_id, key)` — it is QUERIED ACROSS RUNS ("everything this agent has produced"), and it
 * OUTLIVES the run with an id a card can link to. An append-only positional log expresses none of
 * those. What goes in the log is a *thin* `artifact` event row carrying
 * {@link agentArtifactEventDataSchema} — position in the timeline without making the log the store.
 *
 * **Size caps live here, in the contract, not in the table.** An artifact bigger than these belongs
 * in R2 as a `file` artifact; a `json` blob that wants a megabyte is a design mistake the schema
 * should catch at the write, not a jsonb column that quietly grows.
 *
 * Imports zod and siblings only (see `ai/interrupts.ts` for why the direction matters).
 */
import { z } from 'zod'

/** The closed set of things an artifact can be. Append LAST; each kind is one UI branch. */
export const AGENT_ARTIFACT_KINDS = ['document', 'file', 'markdown', 'table', 'json'] as const
export const agentArtifactKindSchema = z.enum(AGENT_ARTIFACT_KINDS)
export type AgentArtifactKind = z.infer<typeof agentArtifactKindSchema>

/** Longest markdown body an artifact may carry inline. Bigger belongs in R2 as a `file`. */
export const ARTIFACT_MARKDOWN_MAX_CHARS = 100_000
/** Most rows a `table` artifact may carry — a table nobody will read is a `file`. */
export const ARTIFACT_TABLE_MAX_ROWS = 1_000
/** Longest `json` artifact, measured as its serialised length. */
export const ARTIFACT_JSON_MAX_CHARS = 100_000

export const artifactTableColumnSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  align: z.enum(['left', 'right', 'center']).optional(),
})
export type ArtifactTableColumn = z.infer<typeof artifactTableColumnSchema>

/**
 * The typed `data` jsonb. `document` and `file` carry **ids, never content**: the bytes already
 * live in `documents` / R2 behind routes that enforce tenancy and, for a document, group
 * visibility (D29). Copying them here would be a second, unscoped copy of the same bytes.
 */
export const agentArtifactDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: z.string().uuid() }),
  z.object({
    kind: z.literal('file'),
    fileId: z.string().uuid(),
    filename: z.string().max(400).optional(),
    contentType: z.string().max(200).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('markdown'),
    markdown: z.string().min(1).max(ARTIFACT_MARKDOWN_MAX_CHARS),
  }),
  z.object({
    kind: z.literal('table'),
    columns: z.array(artifactTableColumnSchema).min(1).max(50),
    rows: z.array(z.record(z.string(), z.unknown())).max(ARTIFACT_TABLE_MAX_ROWS),
  }),
  z.object({
    kind: z.literal('json'),
    json: z.unknown().refine(
      value => {
        try {
          return JSON.stringify(value ?? null).length <= ARTIFACT_JSON_MAX_CHARS
        } catch {
          // Circular or otherwise unserialisable: it was never going to reach a jsonb column.
          return false
        }
      },
      { message: `must serialise to at most ${ARTIFACT_JSON_MAX_CHARS} characters` }
    ),
  }),
])
export type AgentArtifactData = z.infer<typeof agentArtifactDataSchema>

/** What an agent hands `ctx.artifact()`. `key` is the UPSERT key — a redraft replaces itself. */
export const agentArtifactInputSchema = z.object({
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  data: agentArtifactDataSchema,
})
export type AgentArtifactInput = z.infer<typeof agentArtifactInputSchema>

/**
 * One row of `agent_run_artifacts`. `kind` is a real column so `(tenant_id, kind)` can index it;
 * `data.kind` is the same value and the refinement below is what stops the two drifting.
 */
export const agentArtifactSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    runId: z.string().uuid(),
    key: z.string().min(1).max(200),
    kind: agentArtifactKindSchema,
    title: z.string().min(1).max(200),
    description: z.string().nullable(),
    data: agentArtifactDataSchema,
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .refine(artifact => artifact.kind === artifact.data.kind, {
    path: ['kind'],
    message: 'the kind column must match the data discriminant',
  })
export type AgentArtifact = z.infer<typeof agentArtifactSchema>

/**
 * The `data` of an `artifact` event row: where in the timeline it appeared, and enough to draw a
 * link. Deliberately NOT the artifact — the table is the store (decision 4).
 */
export const agentArtifactEventDataSchema = z.object({
  artifactId: z.string().uuid(),
  key: z.string(),
  kind: agentArtifactKindSchema,
  title: z.string(),
})
export type AgentArtifactEventData = z.infer<typeof agentArtifactEventDataSchema>
