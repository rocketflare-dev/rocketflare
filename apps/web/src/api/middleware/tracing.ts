/**
 * Per-request tracer (D32, step 9 in the middleware order): `c.set('tracer', tracerFor(cfg, …))` —
 * the span recorder with the OTLP exporter when a backend is configured and the `ai_spans` store
 * whenever a database is (its OWN short-lived client, because the request's is closed in
 * `waitUntil`, possibly before this flush runs) — and a flush in `waitUntil` AFTER the handler so
 * nothing is sent on the response path. A streaming route whose spans end after `next()` resolves
 * (the chat SSE route) flushes again itself before the stream closes; `flush()` on an empty batch
 * is a no-op and opens no connection, so both flushes are safe.
 */
import { createMiddleware } from 'hono/factory'
import { ownConnectionSpanStore } from '../observability/span-store'
import { tracerFor } from '../observability/tracing'
import type { AppEnv } from '../types'
import { deferOrAwait } from './database'

export const tracerMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const cfg = c.get('config')
  const tracer = tracerFor(cfg, {
    logger: c.get('logger'),
    store: ownConnectionSpanStore(cfg, c.env),
  })
  c.set('tracer', tracer)
  try {
    await next()
  } finally {
    if (tracer.enabled) await deferOrAwait(c, () => tracer.flush())
  }
})
