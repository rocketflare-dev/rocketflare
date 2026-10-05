/**
 * `/api/memory` (D36) — a person's own memory: what the assistant learned from their chats.
 * Mounted behind `requireFeature('memory')`, so an organisation without the flag has no surface.
 *
 * - `GET /` — the memories this reader may see (their own, plus anything shared with them),
 *   newest said first; `q` (full-text), `from`/`to` (time overlap), `includeHistorical`.
 * - `GET /entities` — the people and things their memory names.
 * - `DELETE /:id` — forget one they OWN (anything else is 404, admins included).
 * - `DELETE /` — forget everything they own here.
 * - `GET|PUT /settings` — their own switch; `available` is the organisation's.
 *
 * Every route is `manage Memory`, which every member holds: memory is personal, and the services
 * filter by owner the way the chat routes filter by `userId`.
 */
import {
  memoryEntityListResponseSchema,
  memoryForgetResponseSchema,
  memoryIdParamSchema,
  memoryListQuerySchema,
  memoryListResponseSchema,
  memorySettingsSchema,
  updateMemorySettingsRequestSchema,
} from '@rocketflare/shared/ai/memory'
import { guardPermission } from '../middleware/permissions'
import { accessScopeOf } from '../services/access'
import { memoryOptedOutFor, setMemoryEnabled } from '../services/ai/memory/settings'
import {
  forgetAllMemories,
  forgetMemory,
  listMemories,
  listMemoryEntities,
} from '../services/ai/memory/store'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const memoryRouter = createRouter()

memoryRouter.get('/', validate('query', memoryListQuerySchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Memory')
  const page = await listMemories(db, accessScopeOf(auth), c.req.valid('query'))
  return c.json(memoryListResponseSchema.parse(page))
})

memoryRouter.get('/entities', async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Memory')
  const items = await listMemoryEntities(db, accessScopeOf(auth))
  return c.json(memoryEntityListResponseSchema.parse({ items }))
})

memoryRouter.get('/settings', async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Memory')
  const optedOut = await memoryOptedOutFor(db, tenantId, user.id)
  return c.json(
    memorySettingsSchema.parse({ available: auth.features.includes('memory'), enabled: !optedOut })
  )
})

memoryRouter.put('/settings', validate('json', updateMemorySettingsRequestSchema), async c => {
  const { db, tenantId, user, auth } = withAuthAndDb(c)
  guardPermission(c, 'update', 'Memory')
  const { enabled } = c.req.valid('json')
  await setMemoryEnabled(db, tenantId, user.id, enabled)
  return c.json(
    memorySettingsSchema.parse({ available: auth.features.includes('memory'), enabled })
  )
})

memoryRouter.delete('/:id', validate('param', memoryIdParamSchema), async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'delete', 'Memory')
  await forgetMemory(db, accessScopeOf(auth), c.req.valid('param').id)
  return c.body(null, 204)
})

memoryRouter.delete('/', async c => {
  const { db, auth } = withAuthAndDb(c)
  guardPermission(c, 'delete', 'Memory')
  const deleted = await forgetAllMemories(db, accessScopeOf(auth))
  return c.json(memoryForgetResponseSchema.parse({ deleted }))
})
