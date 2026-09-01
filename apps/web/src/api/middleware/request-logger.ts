/**
 * Request id + hono-pino request logging (D16, 04 §4). Runs FIRST (before config) so every
 * later failure — including config validation — carries a `requestId`. Because it precedes
 * `configMiddleware` it calls `loadConfig(c.env)` itself; if that throws it falls back to a
 * plain `info` logger and lets `configMiddleware` raise the real error one step later.
 *
 * The root pino logger is memoised per env object (one per isolate in production).
 */

import type { MiddlewareHandler } from 'hono'
import { requestId } from 'hono/request-id'
import { pinoLogger } from 'hono-pino'
import { loadConfig } from '../../config'
import type { AppEnv } from '../types'
import { createLogger, type Logger, loggerOptionsFor } from '../utils/core/logger'

const rootLoggers = new WeakMap<object, Logger>()

/** Fallback used only when the env fails validation; the real error surfaces from configMiddleware. */
export const fallbackLogger: Logger = createLogger({ level: 'info' })

export function rootLoggerFor(env: object): Logger {
  const cached = rootLoggers.get(env)
  if (cached) return cached
  let logger: Logger
  try {
    logger = createLogger(loggerOptionsFor(loadConfig(env)))
  } catch {
    return fallbackLogger
  }
  rootLoggers.set(env, logger)
  return logger
}

/** `hono/request-id`: honours an incoming `X-Request-Id`, else `crypto.randomUUID()`; echoed on the response. */
export const requestIdMiddleware: MiddlewareHandler<AppEnv> = requestId()

/** hono-pino: `c.get('logger')` + one line per response. Mount right after `requestIdMiddleware`. */
export const requestLogger = pinoLogger({
  pino: c => rootLoggerFor(c.env as object),
  http: {
    // hono-pino reads `requestId` from context (set by requestIdMiddleware just before).
    referRequestIdKey: 'requestId',
    // One compact line per request; the defaults dump every request/response header.
    onReqBindings: c => ({ req: { method: c.req.method, url: c.req.path } }),
    onResBindings: c => ({ res: { status: c.res.status } }),
  },
}) as unknown as MiddlewareHandler<AppEnv>
