/**
 * `/api/uploads`: direct-to-storage uploads (`services/uploads/service.ts`). The bytes never come
 * here — the client asks for a URL, `PUT`s the file to storage, then confirms.
 *
 *   POST /api/uploads              { target, name, contentType, size, fields? } → 201 the PUT URL;
 *                                  the target's 400/403/413/415/503 before any byte is stored
 *   POST /api/uploads/:id/confirm  → the target's answer (a `files` row 201, a document 201/200);
 *                                  404 unknown / another tenant's / already confirmed, 410 expired,
 *                                  400 `upload_missing` / `upload_mismatch`
 *
 * `localUploadRouter` is the Worker's own stand-in for R2's presigned PUT, handed out whenever the
 * R2 key pair is not set — in `development` and on a deployed Worker without it (up to
 * `MAX_WORKER_UPLOAD_BYTES`, 10 MB, there). Mounted outside the authed table
 * (`/api/upload-content/:id?token=`): the token is its credential.
 */
import { createUploadRequestSchema } from '@rocketflare/shared/uploads'
import { confirmUpload, createUpload, receiveLocalUpload } from '../services/uploads/service'
import { uuidParam } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'
import { validate } from '../utils/routes/validate'

export const uploadsRouter = createRouter()

uploadsRouter.post('/', validate('json', createUploadRequestSchema), async c => {
  return c.json(await createUpload(c, c.req.valid('json')), 201)
})

uploadsRouter.post('/:id/confirm', async c => {
  const { status, body } = await confirmUpload(c, uuidParam(c, 'id'))
  return c.json(body as object, status)
})

export const localUploadRouter = createRouter()

localUploadRouter.put('/:id', async c => {
  await receiveLocalUpload(c, uuidParam(c, 'id'))
  return c.body(null, 200)
})
