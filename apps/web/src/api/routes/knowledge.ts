/**
 * `/api/knowledge`: reviewing knowledge facts (D43). Mounted behind `authMiddleware` AND
 * `requireFeature('knowledge-facts')` in `api/index.ts`, so with the flag off every route here is
 * the 404 `feature_disabled` an unknown route is.
 *
 * - `GET /review` — open items (facts unconfirmed or in conflict, staging entities with a
 *   possible match): mine, or everyone's with `manage KnowledgeFact` (`?mine=true` narrows).
 * - `POST /facts/:id/review` `{ action: confirm | reject | prefer }`.
 * - `GET /entities/:type/:id` — the entity card.
 * - `GET /mentioned?q=` — the facts about the entities a search query names (the Search page).
 * - `GET /documents/:id/facts` — the facts read from one document (the document viewer).
 * - `GET /entities` — entities with current facts, counts and filters (the Knowledge Facts view).
 * - `POST /entities/:id/merge` `{ into }` · `/promote` `{ id }` · `/keep-separate`.
 * - `GET /entities/:id/promote-candidates?q=` — the Promote picker (the type's rows matching `q`).
 *
 * Who: `read KnowledgeFact` to read, `update KnowledgeFact` to act — and acting on an item is its
 * reviewer's or a manager's (403 otherwise). What: a fact is read through its document's
 * visibility, so one you may not see is a 404, never a 403 (`services/knowledge/facts-read.ts`).
 * Every action nudges `entity.changed { entity: 'knowledge', id }` after it commits.
 */
import {
  entityCardParamSchema,
  factReviewRequestSchema,
  type KnowledgeEntityList,
  knowledgeEntityListQuerySchema,
  knowledgeReviewQuerySchema,
  type MentionedFactsResponse,
  mentionedFactsQuerySchema,
  mergeEntityRequestSchema,
  promoteCandidatesQuerySchema,
  promoteEntityRequestSchema,
} from '@rocketflare/shared/ai/knowledge-facts'
import { can, guardPermission } from '../middleware/permissions'
import { accessScopeOf } from '../services/access'
import { recordActivity } from '../services/activity'
import {
  getEntityCard,
  listKnowledgeEntities,
  listReviewItems,
  type ReviewReader,
  readDocumentFacts,
} from '../services/knowledge/facts-read'
import { factsForQuery } from '../services/knowledge/lookup'
import {
  keepEntitySeparate,
  mergeEntity,
  promoteCandidates,
  promoteEntity,
  reviewFact,
} from '../services/knowledge/review'
import type { AppContext } from '../types'
import { pageWindow, paginated } from '../utils/routes/pagination'
import { uuidParam, withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const knowledgeRouter = createRouter()

function readerOf(c: AppContext): ReviewReader {
  const { auth, user } = withAuthAndDb(c)
  return {
    scope: accessScopeOf(auth),
    userId: user.id,
    canManage: can(c, 'manage', 'KnowledgeFact'),
  }
}

knowledgeRouter.get('/review', validate('query', knowledgeReviewQuerySchema), async c => {
  const { db } = withAuthAndDb(c)
  guardPermission(c, 'read', 'KnowledgeFact')
  const query = c.req.valid('query')
  const { items, total } = await listReviewItems(db, readerOf(c), query)
  return c.json(paginated(items, total, query))
})

knowledgeRouter.post('/facts/:id/review', validate('json', factReviewRequestSchema), async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'update', 'KnowledgeFact')
  const id = uuidParam(c, 'id')
  const { action } = c.req.valid('json')
  const result = await reviewFact(db, readerOf(c), id, action, realtime)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'knowledge.fact.reviewed',
      subjectType: 'KnowledgeFact',
      subjectId: id,
      metadata: { action, state: result.fact.state, affected: result.affected.length },
    })
  )
  return c.json(result)
})

knowledgeRouter.get('/mentioned', validate('query', mentionedFactsQuerySchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'KnowledgeFact')
  const { q } = c.req.valid('query')
  const body: MentionedFactsResponse = { entities: await factsForQuery(db, accessScopeOf(auth), q) }
  return c.json(body)
})

knowledgeRouter.get('/documents/:id/facts', async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'KnowledgeFact')
  return c.json(await readDocumentFacts(db, accessScopeOf(auth), uuidParam(c, 'id')))
})

knowledgeRouter.get('/entities', validate('query', knowledgeEntityListQuerySchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'KnowledgeFact')
  const query = c.req.valid('query')
  const { items, total, facets } = await listKnowledgeEntities(
    db,
    accessScopeOf(auth),
    query,
    pageWindow(query)
  )
  const body: KnowledgeEntityList = { ...paginated(items, total, query), facets }
  return c.json(body)
})

// Before `/entities/:type/:id`, which would otherwise read this as type = id, id = the word.
knowledgeRouter.get(
  '/entities/:id/promote-candidates',
  validate('query', promoteCandidatesQuerySchema),
  async c => {
    const { db } = withAuthAndDb(c)
    guardPermission(c, 'update', 'KnowledgeFact')
    const { q } = c.req.valid('query')
    return c.json(await promoteCandidates(db, readerOf(c), uuidParam(c, 'id'), q))
  }
)

knowledgeRouter.get('/entities/:type/:id', validate('param', entityCardParamSchema), async c => {
  const { db } = withAuthAndDb(c)
  guardPermission(c, 'read', 'KnowledgeFact')
  const { type, id } = c.req.valid('param')
  return c.json(await getEntityCard(db, accessScopeOf(withAuthAndDb(c).auth), type, id))
})

knowledgeRouter.post('/entities/:id/merge', validate('json', mergeEntityRequestSchema), async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'update', 'KnowledgeFact')
  const id = uuidParam(c, 'id')
  const { into } = c.req.valid('json')
  const result = await mergeEntity(db, readerOf(c), id, into, realtime)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: into.kind === 'domain' ? 'knowledge.entity.promoted' : 'knowledge.entity.merged',
      subjectType: 'KnowledgeFact',
      subjectId: id,
      metadata: { into: result.into, movedFacts: result.movedFacts },
    })
  )
  return c.json(result)
})

knowledgeRouter.post(
  '/entities/:id/promote',
  validate('json', promoteEntityRequestSchema),
  async c => {
    const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
    guardPermission(c, 'update', 'KnowledgeFact')
    const id = uuidParam(c, 'id')
    const result = await promoteEntity(db, readerOf(c), id, c.req.valid('json').id, realtime)
    defer(() =>
      recordActivity(db, {
        tenantId,
        userId: user.id,
        type: 'knowledge.entity.promoted',
        subjectType: 'KnowledgeFact',
        subjectId: id,
        metadata: { into: result.into, movedFacts: result.movedFacts },
      })
    )
    return c.json(result)
  }
)

knowledgeRouter.post('/entities/:id/keep-separate', async c => {
  const { db, tenantId, user, defer, realtime } = withAuthAndDb(c)
  guardPermission(c, 'update', 'KnowledgeFact')
  const id = uuidParam(c, 'id')
  const result = await keepEntitySeparate(db, readerOf(c), id, realtime)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'knowledge.entity.kept_separate',
      subjectType: 'KnowledgeFact',
      subjectId: id,
    })
  )
  return c.json(result)
})
