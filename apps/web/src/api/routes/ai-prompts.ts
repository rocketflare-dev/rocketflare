/**
 * `/api/ai/prompts` (D17): the prompt registry with this tenant's overrides. `GET /` lists every
 * registry entry + override + effective text (members may read — the prompt shapes what answers
 * them); `PUT /:key` sets an override and `DELETE /:key` reverts to the default (`manage Prompt`,
 * admin+). Unknown keys are 404: the registry is code, not a table.
 */
import { updatePromptRequestSchema } from '@rocketflare/shared/ai/prompts'
import { guardPermission } from '../middleware/permissions'
import { recordActivity } from '../services/activity'
import {
  clearPromptOverride,
  getPrompt,
  isPromptKey,
  listPrompts,
  type RegistryPromptKey,
  setPromptOverride,
} from '../services/prompts'
import type { AppContext } from '../types'
import { NotFoundError } from '../utils/core/errors'
import { withAuthAndDb } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const aiPromptsRouter = createRouter()

function keyParam(c: AppContext): RegistryPromptKey {
  const key = c.req.param('key') ?? ''
  if (!isPromptKey(key)) throw new NotFoundError(`Unknown prompt: ${key}`, 'prompt_not_found')
  return key
}

aiPromptsRouter.get('/', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Prompt')
  return c.json({ items: await listPrompts(db, tenantId) })
})

aiPromptsRouter.get('/:key', async c => {
  const { db, tenantId } = withAuthAndDb(c)
  guardPermission(c, 'read', 'Prompt')
  return c.json(await getPrompt(db, tenantId, keyParam(c)))
})

aiPromptsRouter.put('/:key', validate('json', updatePromptRequestSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Prompt')
  const key = keyParam(c)
  const result = await setPromptOverride(db, tenantId, key, c.req.valid('json').text, user.id)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'prompt.overridden',
      subjectType: 'Prompt',
      subjectId: key,
    })
  )
  return c.json(result)
})

aiPromptsRouter.delete('/:key', async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c)
  guardPermission(c, 'manage', 'Prompt')
  const key = keyParam(c)
  const result = await clearPromptOverride(db, tenantId, key)
  defer(() =>
    recordActivity(db, {
      tenantId,
      userId: user.id,
      type: 'prompt.reverted',
      subjectType: 'Prompt',
      subjectId: key,
    })
  )
  return c.json(result)
})
