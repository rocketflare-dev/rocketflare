/**
 * `example-feature` — the kit's reference PLUGIN (D31, decision 3), shared half.
 *
 * It exists to be deleted, and to be read first. Between the three entries it exercises every slot
 * the seam has: a feature flag, a job type, a CASL subject and grants, a tenant-scoped table with
 * an RLS policy, a CRUD route, an agent tool, `onTenantCreated`, `seedDemo`, a lazy page with a nav
 * item, and two CLI commands. Delete it with `pnpm plugin remove example-feature` (or by hand: its
 * three directories, the five barrel lines and its surface in `.rocketflare.json`) and the kit is
 * bare again.
 *
 * **Everything it keys carries the plugin's id**, which is the rule that lets two plugins live in
 * one app: the table is `example_notes`, the job type `example-feature.ping`, the API prefix
 * `/api/example-feature`, the query-key roots `example-feature:…`, the CLI command
 * `rocketflare example-feature`. The flag key is the bare `example-feature` because the flag IS the
 * plugin — there is nothing to distinguish it from.
 *
 * **This module never imports a composer at runtime** (`permissions.ts`, `features.ts`, `jobs.ts`,
 * `ai/agents.ts`, `realtime.ts`): those five read the plugin barrel, so importing one back closes a
 * cycle that crashes at module evaluation rather than failing to compile. The whole-declaration
 * `import type` below is erased, which is how `features` is typed against the ONE
 * `FeatureDefinition` rather than a restatement that drifts.
 */
import { z } from 'zod'
import type { FeatureDefinition } from '../../features'
import { paginatedResponse, paginationQuerySchema } from '../../pagination'
import type { SharedPlugin } from '../types'

/** The plugin's id — and the namespace for every key below. */
export const EXAMPLE_FEATURE_ID = 'example-feature'

/**
 * The flag that gates the nav item, the page and the `/api/example-feature` mount (D30). It is one
 * key, not one per surface: a feature is a surface, and gating its doors separately is how a nav
 * item and its routes come to disagree.
 */
export const EXAMPLE_FEATURE_FLAG = 'example-feature'

/** The smoke job's type. `<id>.<verb>`, so it cannot collide with a kit type or another plugin's. */
export const EXAMPLE_PING_JOB = 'example-feature.ping'

/** The CASL subject the plugin's rows are governed by. */
export const EXAMPLE_NOTE_SUBJECT = 'ExampleNote'

export const EXAMPLE_NOTE_TITLE_MAX = 200
export const EXAMPLE_NOTE_BODY_MAX = 4_000

// ---- Contracts ---------------------------------------------------------------------------------

/** One note, as every consumer sees it. `ownerUserId` is what the route's own-row check reads. */
export const exampleNoteSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  ownerUserId: z.string().uuid().nullable(),
  title: z.string(),
  body: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})
export type ExampleNote = z.infer<typeof exampleNoteSchema>

export const exampleNoteListResponseSchema = paginatedResponse(exampleNoteSchema)
export type ExampleNoteListResponse = z.infer<typeof exampleNoteListResponseSchema>

export const exampleNoteListQuerySchema = paginationQuerySchema
export type ExampleNoteListQuery = z.infer<typeof exampleNoteListQuerySchema>

export const createExampleNoteRequestSchema = z.object({
  title: z.string().trim().min(1).max(EXAMPLE_NOTE_TITLE_MAX),
  body: z.string().trim().max(EXAMPLE_NOTE_BODY_MAX).default(''),
})
export type CreateExampleNoteRequest = z.infer<typeof createExampleNoteRequestSchema>

export const updateExampleNoteRequestSchema = createExampleNoteRequestSchema
  .partial()
  .refine(body => Object.keys(body).length > 0, { message: 'Nothing to update' })
export type UpdateExampleNoteRequest = z.infer<typeof updateExampleNoteRequestSchema>

/** `POST /api/example-feature/ping` — the envelope the route enqueued, so a caller can find it. */
export const examplePingResponseSchema = z.object({
  jobId: z.string().uuid(),
  type: z.literal(EXAMPLE_PING_JOB),
  enqueuedAt: z.string().datetime(),
})
export type ExamplePingResponse = z.infer<typeof examplePingResponseSchema>

/** The job's payload. Ids and a note only — a handler recomputes everything else from the DB. */
export const examplePingPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  note: z.string().max(200).optional(),
})
export type ExamplePingPayload = z.infer<typeof examplePingPayloadSchema>

// ---- The plugin ---------------------------------------------------------------------------------

/**
 * `as const satisfies SharedPlugin` is load-bearing on both halves: `satisfies` checks the shape
 * here, where the author is looking, and `as const` keeps `subjects` a tuple of literals so
 * `PluginSubject` names `'ExampleNote'` rather than widening to `string`.
 */
export const exampleFeatureShared = {
  id: EXAMPLE_FEATURE_ID,
  label: 'Example feature',
  version: '0.1.0',
  subjects: [EXAMPLE_NOTE_SUBJECT],
  jobs: [z.object({ type: z.literal(EXAMPLE_PING_JOB), payload: examplePingPayloadSchema })],
  features: {
    [EXAMPLE_FEATURE_FLAG]: {
      label: 'Example feature',
      description:
        'The kit’s demonstration flag, shipped as a plugin. Gates one nav item, one page and the ' +
        '/api/example-feature mount, so the whole path — environment, rollout, override, session, ' +
        'nav, server — can be seen working. Safe to delete.',
      defaultState: 'off',
      defaultRolloutUnit: 'tenant',
      environmentGated: false,
    } satisfies FeatureDefinition,
  },
} as const satisfies SharedPlugin
