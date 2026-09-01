/**
 * `app.onError` + `app.notFound` (D13): the ONLY place errors become responses, always in the
 * shared envelope `{ error, statusCode, code?, details? }`. Mapping:
 *   ApiError → its own status/body · HTTPException (Hono built-ins) → status + message ·
 *   ZodError → 400 validation_failed with issues · infrastructure faults (42501, connection)
 *   → typed 500/503 · anything else → 500 with the message hidden outside development.
 * Registered first so even config-validation failures get the envelope and a log line.
 */
import type { ApiErrorBody } from '@rocketflare/shared/errors'
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ZodError } from 'zod'
import type { AppContext, AppEnv } from '../types'
import {
  classifyInfrastructureError,
  type InfrastructureFault,
  isApiError,
  mapInfrastructureError,
  ValidationError,
} from '../utils/core/errors'
import { fallbackLogger } from './request-logger'

/** One fixed, greppable line per fault — production has structured logs and nothing else. */
const FAULT_MESSAGES: Record<InfrastructureFault, string> = {
  tenant_isolation_violation:
    'TENANT ISOLATION VIOLATION: a row-level security policy rejected a write',
  tenant_scope_conflict: 'TENANT SCOPE CONFLICT: a nested scope asked for a different tenant',
  database_unavailable: 'DATABASE UNAVAILABLE: could not obtain a database connection',
}

export function notFoundBody(path: string): ApiErrorBody {
  return { error: `Not found: ${path}`, statusCode: 404, code: ERROR_CODES.notFound }
}

export const notFoundHandler: NotFoundHandler<AppEnv> = c => c.json(notFoundBody(c.req.path), 404)

function safeGet<K extends keyof AppEnv['Variables']>(c: AppContext, key: K) {
  try {
    return c.get(key)
  } catch {
    return undefined
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const logger = safeGet(c, 'logger') ?? fallbackLogger
  const requestId = safeGet(c, 'requestId')
  const isDev = safeGet(c, 'config')?.APP_ENV === 'development'

  const fault = classifyInfrastructureError(err)
  if (fault) {
    logger.error(
      { event: fault, path: c.req.path, method: c.req.method, err },
      FAULT_MESSAGES[fault]
    )
  }

  const mapped =
    mapInfrastructureError(err) ?? (err instanceof ZodError ? new ValidationError(err.issues) : err)

  if (isApiError(mapped)) {
    if (mapped.statusCode >= 500) logger.error({ err, requestId }, mapped.name)
    else logger.debug({ err: mapped, requestId }, mapped.name)
    return c.json(mapped.toJSON(), mapped.statusCode as ContentfulStatusCode)
  }

  if (mapped instanceof HTTPException) {
    const body: ApiErrorBody = {
      error: mapped.message || 'Request failed',
      statusCode: mapped.status,
    }
    return c.json(body, mapped.status as ContentfulStatusCode)
  }

  logger.error({ err, requestId, path: c.req.path, method: c.req.method }, 'Unhandled error')
  const body: ApiErrorBody = {
    error: isDev && err instanceof Error ? err.message : 'Internal server error',
    statusCode: 500,
    details: requestId ? { requestId } : undefined,
  }
  return c.json(body, 500)
}
