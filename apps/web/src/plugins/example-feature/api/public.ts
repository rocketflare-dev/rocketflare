/**
 * `/api/hooks/example-feature` (D34) — the reference plugin's PUBLIC mount.
 *
 *   GET    /ping?state=…            no session — verify the signed link, enqueue the smoke job, 202
 *
 * The shape every consent callback and webhook takes, small enough to read in one go:
 *
 * 1. **Prove who is calling** before touching anything. Here that is `verifyState` over a token the
 *    authed `POST /ping-link` minted; a webhook would compare a stored secret or check the
 *    provider's signature instead. Every failure is the same 401 — the caller learns nothing about
 *    WHICH check it failed.
 * 2. **Only then name a tenant**, and only the one the proof carried. `PublicCtx` has no ambient
 *    tenant on purpose.
 * 3. **Re-check the flag** with `ctx.features(tenantId)`: the authed mount's `requireFeature` gate
 *    cannot run here (there is no `auth.features`), so a surface that has gone dark since the link
 *    was minted would otherwise still answer.
 * 4. **Enqueue and answer fast** — the provider on the other end of a real webhook counts seconds.
 */
import {
  EXAMPLE_FEATURE_FLAG,
  EXAMPLE_PING_JOB,
} from '@rocketflare/shared/plugins/example-feature/index'
import { z } from 'zod'
import type { PublicCtx } from '@/plugins/api'
import { createRouter, publicCtx, verifyState } from '@/plugins/api'
import { EXAMPLE_PING_LINK_PURPOSE } from '../shared'

/** What the link's state carries. Parsed even though it is signed: a signature proves the writer, not the shape. */
const pingLinkStateSchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() })

export const exampleFeaturePublicRouter = createRouter()

exampleFeaturePublicRouter.get('/ping', async c => {
  const ctx: PublicCtx = publicCtx(c)
  const token = c.req.query('state') ?? ''
  const state = pingLinkStateSchema.safeParse(
    await verifyState(ctx.config, EXAMPLE_PING_LINK_PURPOSE, token)
  )
  if (!state.success) ctx.unauthorized('This link is invalid or has expired')
  const { tenantId } = state.data
  if (!(await ctx.features(tenantId)).includes(EXAMPLE_FEATURE_FLAG)) {
    ctx.notFound('Not found', 'feature_disabled')
  }
  const job = await ctx.enqueue({
    type: EXAMPLE_PING_JOB,
    payload: { tenantId, note: 'from the public ping link' },
  })
  return c.json({ jobId: job.id, type: job.type, enqueuedAt: job.enqueuedAt }, 202)
})
