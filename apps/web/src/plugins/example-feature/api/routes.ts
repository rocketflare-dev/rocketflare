/**
 * `/api/example-feature` (D31) — the reference plugin's CRUD surface.
 *
 *   POST   /ping                    read ExampleNote   — enqueue the smoke job, 202
 *   GET    /notes                   read ExampleNote
 *   POST   /notes                   create ExampleNote
 *   GET    /notes/:id               read ExampleNote
 *   PATCH  /notes/:id               own row, else update ExampleNote (admin+)
 *   DELETE /notes/:id               own row, else delete ExampleNote (admin+)
 *
 * Nothing here is plugin-specific except the names. A plugin route is a kit route in every respect —
 * `createRouter()`, `validate()` with the contract from the plugin's own shared entry, an
 * authorisation check, a tenant predicate on every query, typed errors rather than hand-rolled JSON.
 * What differs is only where it is REGISTERED (`ServerPlugin.mounts`) and how it reaches the kit:
 * through `requestCtx(c)` rather than through nine imports of kit internals.
 *
 * **Two authorisation facts, kept apart.** `ctx.guard` answers "may this ROLE do this KIND of
 * thing"; "is this row yours" is the route's own `ownerUserId` check, exactly as `routes/files.ts`
 * and `routes/ai-documents.ts` do it. CASL conditions are used nowhere in this kit, and a plugin
 * inventing them would be the only place they appear.
 *
 * The error helpers THROW and return `never`, which is why `if (!row) ctx.notFound(...)` leaves
 * `row` non-null on the next line without a `throw` in front of it — **but only because `ctx` below
 * carries an explicit `: RequestCtx` annotation.** TypeScript applies never-return narrowing only
 * when every name in the call target is explicitly annotated, and `const ctx = requestCtx(c)` is
 * inferred; without the annotation the guard still throws at runtime while the compiler goes on
 * believing the row may be undefined, which surfaces as an error somewhere else entirely (or, where
 * the value is only passed to something permissive, not at all).
 *
 * The whole mount is behind `requireFeature('example-feature')` (see `../index.ts`), so with the
 * flag off every path here is a 404 `feature_disabled` — a 403 would confirm the surface exists.
 */
import {
  type CreateExampleNoteRequest,
  createExampleNoteRequestSchema,
  EXAMPLE_NOTE_SUBJECT,
  EXAMPLE_PING_JOB,
  type ExampleNoteListQuery,
  exampleNoteListQuerySchema,
  type UpdateExampleNoteRequest,
  updateExampleNoteRequestSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import type { RequestCtx } from '@/plugins/api'
import { createRouter, requestCtx, validate } from '@/plugins/api'
import { EXAMPLE_NOTES_ENTITY } from '../shared'
import {
  createExampleNote,
  deleteExampleNote,
  getExampleNote,
  listExampleNotes,
  updateExampleNote,
} from './notes'

export const exampleFeatureRouter = createRouter()

// ---- The smoke job --------------------------------------------------------------------------

/**
 * Prove the producer → Queues → consumer path end to end without leaving the app: this route is all
 * the CLI's `rocketflare example-feature ping` does, which is what keeps the CLI a thin client over
 * the same contract rather than a second place that knows how to build an envelope.
 *
 * **A route never runs long work; it enqueues.** `ctx.enqueue` already has the binding, and a
 * missing one throws rather than running the job inline — which is how a 30-second route ships.
 */
exampleFeatureRouter.post('/ping', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_NOTE_SUBJECT)
  const job = await ctx.enqueue({
    type: EXAMPLE_PING_JOB,
    payload: { tenantId: ctx.tenantId, note: 'from /api/example-feature/ping' },
  })
  return c.json({ jobId: job.id, type: job.type, enqueuedAt: job.enqueuedAt }, 202)
})

// ---- Notes ------------------------------------------------------------------------------------

exampleFeatureRouter.get('/notes', validate('query', exampleNoteListQuerySchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_NOTE_SUBJECT)
  const query = ctx.valid<ExampleNoteListQuery>('query')
  const { items, total } = await listExampleNotes(ctx.db, ctx.tenantId, query)
  return c.json(ctx.page(items, total, query))
})

exampleFeatureRouter.post('/notes', validate('json', createExampleNoteRequestSchema), async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('create', EXAMPLE_NOTE_SUBJECT)
  const row = await createExampleNote(
    ctx.db,
    ctx.tenantId,
    ctx.userId,
    ctx.valid<CreateExampleNoteRequest>('json')
  )
  // The entity string IS this plugin's query-key family root, so everyone in the tenant re-queries
  // and the socket wiring costs no hook-side code (D8).
  ctx.nudge(EXAMPLE_NOTES_ENTITY, row.id)
  return c.json(row, 201)
})

exampleFeatureRouter.get('/notes/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_NOTE_SUBJECT)
  const row = await getExampleNote(ctx.db, ctx.tenantId, ctx.uuid('id'))
  if (!row) ctx.notFound('Note not found')
  return c.json(row)
})

/** The own-row rule, in one place so the two writes cannot drift apart. */
function guardOwnRow(
  ctx: RequestCtx,
  ownerUserId: string | null,
  action: 'update' | 'delete'
): void {
  if (ownerUserId !== null && ownerUserId === ctx.userId) return
  if (!ctx.can(action, EXAMPLE_NOTE_SUBJECT)) {
    ctx.forbidden(`You do not have permission to ${action} this note`)
  }
}

exampleFeatureRouter.patch(
  '/notes/:id',
  validate('json', updateExampleNoteRequestSchema),
  async c => {
    const ctx: RequestCtx = requestCtx(c)
    ctx.guard('read', EXAMPLE_NOTE_SUBJECT)
    const id = ctx.uuid('id')
    const existing = await getExampleNote(ctx.db, ctx.tenantId, id)
    if (!existing) ctx.notFound('Note not found')
    guardOwnRow(ctx, existing.ownerUserId, 'update')
    const row = await updateExampleNote(
      ctx.db,
      ctx.tenantId,
      id,
      ctx.valid<UpdateExampleNoteRequest>('json')
    )
    if (!row) ctx.notFound('Note not found')
    ctx.nudge(EXAMPLE_NOTES_ENTITY, id)
    return c.json(row)
  }
)

exampleFeatureRouter.delete('/notes/:id', async c => {
  const ctx: RequestCtx = requestCtx(c)
  ctx.guard('read', EXAMPLE_NOTE_SUBJECT)
  const id = ctx.uuid('id')
  const existing = await getExampleNote(ctx.db, ctx.tenantId, id)
  if (!existing) ctx.notFound('Note not found')
  guardOwnRow(ctx, existing.ownerUserId, 'delete')
  await deleteExampleNote(ctx.db, ctx.tenantId, id)
  ctx.nudge(EXAMPLE_NOTES_ENTITY, id)
  return c.body(null, 204)
})
