import { ERROR_CODES } from '@shared/errors'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { errorHandler } from '@/api/middleware/error-handler'
import { createRouter } from '@/api/utils/routes/router'
import { validate } from '@/api/utils/routes/validate'
import { json, request } from '../helpers/request'

const router = createRouter()
router.onError(errorHandler)
router.post('/things', validate('json', z.object({ name: z.string().min(2) })), c => {
  const body = c.req.valid('json')
  return c.json({ name: body.name.toUpperCase() })
})

describe('validate()', () => {
  it('passes typed data through on success', async () => {
    const res = await request('/things', { method: 'POST' }, { app: router, json: { name: 'ok' } })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ name: 'OK' })
  })

  it('returns the shared 400 envelope with zod issues on failure', async () => {
    const res = await request('/things', { method: 'POST' }, { app: router, json: { name: 'x' } })
    expect(res.status).toBe(400)
    const body = await json<{ code: string; details: Array<{ path: string[] }> }>(res)
    expect(body).toMatchObject({ statusCode: 400, code: ERROR_CODES.validationFailed })
    expect(body.details[0]?.path).toEqual(['name'])
  })
})
