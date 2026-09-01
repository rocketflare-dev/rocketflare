/**
 * Per-request tracer (D16, step 9 in the middleware order): `c.set('tracer', tracerFor(cfg))` —
 * the Langfuse fetch batcher when both keys are present, the no-op otherwise — and a flush in
 * `waitUntil` AFTER the handler so nothing is sent on the response path. A streaming route whose
 * generations happen after `next()` resolves (the chat SSE route) flushes again itself before the
 * stream closes; `flush()` on an empty batch is a no-op, so both flushes are safe.
 */
import { createMiddleware } from 'hono/factory'
import { tracerFor } from '../observability/tracing'
import type { AppEnv } from '../types'
import { deferOrAwait } from './database'

export const tracerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const tracer = tracerFor(c.get('config'), { logger: c.get('logger') })
  c.set('tracer', tracer)
  try {
    await next()
  } finally {
    if (tracer.enabled) await deferOrAwait(c, () => tracer.flush())
  }
})
