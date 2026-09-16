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
 * Nothing here is plugin-specific except the names. `createRouter()`, `validate()` with the
 * contract from the plugin's own shared entry, `guardPermission` with the plugin's own subject,
 * `withAuthAndDb` for the tenant id, typed errors rather than hand-rolled JSON — the kit's rules
 * for a route are the rules for a plugin route, which is what makes a plugin reviewable.
 *
 * **Two authorisation facts, kept apart.** `guardPermission` answers "may this ROLE do this KIND of
 * thing"; "is this row yours" is the route's own `ownerUserId` check, exactly as `routes/files.ts`
 * and `routes/ai-documents.ts` do it. CASL conditions are used nowhere in this kit, and a plugin
 * inventing them would be the only place they appear.
 *
 * The whole mount is behind `requireFeature('example-feature')` (see `../index.ts`), so with the
 * flag off every path here is a 404 `feature_disabled` — a 403 would confirm the surface exists.
 */
import {
  createExampleNoteRequestSchema,
  EXAMPLE_NOTE_SUBJECT,
  EXAMPLE_PING_JOB,
  exampleNoteListQuerySchema,
  updateExampleNoteRequestSchema,
} from '@rocketflare/shared/plugins/example-feature/index'
import { can, guardPermission } from '../../../api/middleware/permissions'
import { enqueueJob } from '../../../api/services/jobs'
import { nudge, realtimeEvent } from '../../../api/services/realtime'
import type { AppContext } from '../../../api/types'
import { ForbiddenError, NotFoundError } from '../../../api/utils/core/errors'
import { paginated } from '../../../api/utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../../../api/utils/routes/route-helpers'
import { createRouter } from '../../../api/utils/routes/router'
import { validate } from '../../../api/utils/routes/validate'
import { EXAMPLE_NOTES_ENTITY } from '../shared'
import {
  createExampleNote,
  deleteExampleNote,
  getExampleNote,
  listExampleNotes,
  updateExampleNote,
} from './notes'

export const exampleFeatureRouter = createRouter()

/** Everyone in the tenant re-queries; the entity string IS this plugin's query-key family root. */
function nudgeNotes(c: AppContext, tenantId: string, id?: string) {
  const { realtime } = withAuthAndDb(c)
  nudge(
    realtime,
    realtimeEvent('entity.changed', tenantId, { entity: EXAMPLE_NOTES_ENTITY, ...(id && { id }) })
  )
}

// ---- The smoke job --------------------------------------------------------------------------

/**
 * Prove the producer → Queues → consumer path end to end without leaving the app: this route is all
 * the CLI's `rocketflare example-feature ping` does, which is what keeps the CLI a thin client over
 * the same contract rather than a second place that knows how to build an envelope.
 */
exampleFeatureRouter.post('/ping', async c => {
  const { tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', EXAMPLE_NOTE_SUBJECT)
  const job = await enqueueJob(c.env.JOBS_QUEUE, {
    type: EXAMPLE_PING_JOB,
    payload: { tenantId, note: 'from /api/example-feature/ping' },
  })
  return c.json({ jobId: job.id, type: job.type, enqueuedAt: job.enqueuedAt }, 202)
})

// ---- Notes ------------------------------------------------------------------------------------

exampleFeatureRouter.get('/notes', validate('query', exampleNoteListQuerySchema), async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', EXAMPLE_NOTE_SUBJECT)
  const query = c.req.valid('query')
  const { items, total } = await listExampleNotes(db, tenantId, query)
  return c.json(paginated(items, total, query))
})

exampleFeatureRouter.post('/notes', validate('json', createExampleNoteRequestSchema), async c => {
  const { db, tenantId, user } = withAuthAndDb(c)
  guardPermission(c, 'create', EXAMPLE_NOTE_SUBJECT)
  const row = await createExampleNote(db, tenantId, user.id, c.req.valid('json'))
  nudgeNotes(c, tenantId, row.id)
  return c.json(row, 201)
})

exampleFeatureRouter.get('/notes/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', EXAMPLE_NOTE_SUBJECT)
  const row = await getExampleNote(db, tenantId, uuidParam(c, 'id'))
  if (!row) throw new NotFoundError('Note not found')
  return c.json(row)
})

/** The own-row rule, in one place so the two writes cannot drift apart. */
function guardOwnRow(c: AppContext, ownerUserId: string | null, action: 'update' | 'delete'): void {
  const { user } = withAuthAndDb(c)
  if (ownerUserId !== null && ownerUserId === user.id) return
  if (!can(c, action, EXAMPLE_NOTE_SUBJECT)) {
    throw new ForbiddenError(`You do not have permission to ${action} this note`)
  }
}

exampleFeatureRouter.patch(
  '/notes/:id',
  validate('json', updateExampleNoteRequestSchema),
  async c => {
    const { db, tenantId } = withAuthAndDb(c)
    guardPermission(c, 'read', EXAMPLE_NOTE_SUBJECT)
    const id = uuidParam(c, 'id')
    const existing = await getExampleNote(db, tenantId, id)
    if (!existing) throw new NotFoundError('Note not found')
    guardOwnRow(c, existing.ownerUserId, 'update')
    const row = await updateExampleNote(db, tenantId, id, c.req.valid('json'))
    if (!row) throw new NotFoundError('Note not found')
    nudgeNotes(c, tenantId, id)
    return c.json(row)
  }
)

exampleFeatureRouter.delete('/notes/:id', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', EXAMPLE_NOTE_SUBJECT)
  const id = uuidParam(c, 'id')
  const existing = await getExampleNote(db, tenantId, id)
  if (!existing) throw new NotFoundError('Note not found')
  guardOwnRow(c, existing.ownerUserId, 'delete')
  await deleteExampleNote(db, tenantId, id)
  nudgeNotes(c, tenantId, id)
  return c.body(null, 204)
})
