/**
 * `POST /api/identity/events` — the OIDC issuer's identity events under IdP-managed tenancy
 * (`OIDC_MANAGED_TENANCY` + `IDENTITY_WEBHOOK_SECRET`, docs/CONCEPTS.md §2). Public: the
 * Standard Webhooks signature is the authentication (`auth/standard-webhooks.ts`), checked against
 * the raw body before anything is parsed.
 *
 * Answers:
 * - 204 — applied, already applied, stale (something newer is in place), about a person or org
 *   this app has never seen, or an event type this app doesn't know. The issuer stops retrying.
 * - 400 — a known event type whose body doesn't match its shape. The issuer retries and records
 *   the failure, which is where someone looks.
 * - 401 — no or a bad signature, or a timestamp more than five minutes off.
 * - 404 — not configured: managed tenancy off or no secret.
 *
 * The event is applied before answering (`applyIdentityEvent`, a handful of indexed writes); a
 * failure answers 5xx and the issuer retries it.
 */
import { identityEventEnvelopeSchema, identityEventSchema } from '@rocketflare/shared/idp'
import { isIdpManaged } from '../../config'
import { verifyStandardWebhook, webhookHeaders } from '../auth/standard-webhooks'
import { applyIdentityEvent } from '../services/idp-tenancy'
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/core/errors'
import { makeDefer } from '../utils/routes/route-helpers'
import { createRouter } from '../utils/routes/router'

export const identityEventsRouter = createRouter()

identityEventsRouter.post('/events', async c => {
  const cfg = c.get('config')
  const logger = c.get('logger')
  const secret = cfg.IDENTITY_WEBHOOK_SECRET
  if (!isIdpManaged(cfg) || !secret) throw new NotFoundError('Not found')

  const body = await c.req.text()
  const headers = webhookHeaders(name => c.req.header(name))
  if (!headers || !(await verifyStandardWebhook(secret, headers, body))) {
    throw new UnauthorizedError('Bad or missing webhook signature')
  }

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    throw new ValidationError([{ message: 'The body is not JSON' }])
  }
  const envelope = identityEventEnvelopeSchema.safeParse(json)
  if (!envelope.success) throw new ValidationError(envelope.error.issues)
  const parsed = identityEventSchema.safeParse(json)
  if (!parsed.success) {
    const known = identityEventSchema.options.some(o => o.shape.type.value === envelope.data.type)
    if (!known) {
      logger.info(
        { eventId: envelope.data.id, type: envelope.data.type },
        'identity event: unknown type, ignored'
      )
      return c.body(null, 204)
    }
    throw new ValidationError(parsed.error.issues)
  }

  const outcome = await applyIdentityEvent(c.get('db'), cfg, parsed.data, {
    defer: makeDefer(c),
    env: c.env,
  })
  logger.info({ eventId: parsed.data.id, type: parsed.data.type, outcome }, 'identity event')
  return c.body(null, 204)
})
