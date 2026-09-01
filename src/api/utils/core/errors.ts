/**
 * Typed error tree (D13). Every `ApiError` serialises to the shared envelope
 * `{ error, statusCode, code?, details? }` from `src/shared/errors.ts`; `middleware/error-handler.ts`
 * is the only place that turns errors into responses. Ported from the Node reference app
 * `src/api/utils/core/errors.ts`, trimmed to the generic classes and with `code` promoted to a
 * first-class field instead of ad-hoc `context.code`.
 */
import { type ApiErrorBody, ERROR_CODES, type ErrorCode } from '@shared/errors'
import { TenantScopeConflictError } from '../../../db/tenant-scope'

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: ErrorCode | (string & {}),
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toJSON(): ApiErrorBody {
    return {
      error: this.message,
      statusCode: this.statusCode,
      ...(this.code !== undefined && { code: this.code }),
      ...(this.details !== undefined && { details: this.details }),
    }
  }
}

export class BadRequestError extends ApiError {
  constructor(message = 'Bad request', code?: string, details?: unknown) {
    super(400, message, code, details)
    this.name = 'BadRequestError'
  }
}

/** 400 with `code: validation_failed`; `details` carries the zod issues. */
export class ValidationError extends BadRequestError {
  constructor(details: unknown, message = 'Validation failed') {
    super(message, ERROR_CODES.validationFailed, details)
    this.name = 'ValidationError'
  }
}

export class UnauthorizedError extends ApiError {
  constructor(
    message = 'Unauthorized',
    code: string = ERROR_CODES.unauthorized,
    details?: unknown
  ) {
    super(401, message, code, details)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Forbidden', code: string = ERROR_CODES.forbidden, details?: unknown) {
    super(403, message, code, details)
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Not found', code: string = ERROR_CODES.notFound, details?: unknown) {
    super(404, message, code, details)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends ApiError {
  constructor(message = 'Conflict', code: string = ERROR_CODES.conflict, details?: unknown) {
    super(409, message, code, details)
    this.name = 'ConflictError'
  }
}

export class RateLimitedError extends ApiError {
  constructor(
    message = 'Too many requests',
    public readonly retryAfterSeconds?: number
  ) {
    super(
      429,
      message,
      ERROR_CODES.rateLimited,
      retryAfterSeconds ? { retryAfterSeconds } : undefined
    )
    this.name = 'RateLimitedError'
  }
}

export class InternalServerError extends ApiError {
  constructor(message = 'Internal server error', details?: unknown) {
    super(500, message, undefined, details)
    this.name = 'InternalServerError'
  }
}

export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service unavailable', code?: string) {
    super(503, message, code)
    this.name = 'ServiceUnavailableError'
  }
}

/**
 * 500 — a row-level security policy rejected a write (Postgres `42501`). A cross-tenant READ
 * narrows silently to zero rows; only a WRITE gets here, and it ALWAYS means a bug (a query
 * took `tenantId` from the request instead of the auth context). The body stays generic; the
 * name exists to be greppable in logs.
 */
export class TenantIsolationViolationError extends InternalServerError {
  constructor(cause: unknown) {
    super()
    this.name = 'TenantIsolationViolationError'
    this.cause = cause
  }
}

export class DatabaseUnavailableError extends ServiceUnavailableError {
  constructor() {
    super('Database temporarily unavailable', 'database_unavailable')
    this.name = 'DatabaseUnavailableError'
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** Postgres `insufficient_privilege` — what an RLS `WITH CHECK` failure raises. */
const PG_INSUFFICIENT_PRIVILEGE = '42501'
/** postgres.js codes for "could not reach the database at all". */
const PG_CONNECTION_CODES = new Set([
  'CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  '57P01',
  '53300',
])

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * The error plus its `cause` chain, bounded. drizzle wraps EVERY driver failure in a
 * `DrizzleQueryError`, so a `42501` or our own scope errors never arrive as the top-level throw.
 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth++) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

export type InfrastructureFault =
  | 'tenant_isolation_violation'
  | 'tenant_scope_conflict'
  | 'database_unavailable'

/** Name a driver/infrastructure failure, or null if it is already typed or unrecognised. */
export function classifyInfrastructureError(error: unknown): InfrastructureFault | null {
  if (isApiError(error)) return null
  for (const link of errorChain(error)) {
    const code = errorCode(link)
    if (code === PG_INSUFFICIENT_PRIVILEGE) return 'tenant_isolation_violation'
    if (code && PG_CONNECTION_CODES.has(code)) return 'database_unavailable'
    if (link instanceof TenantScopeConflictError) return 'tenant_scope_conflict'
  }
  return null
}

/** Translate a driver/infrastructure failure into a typed `ApiError`, or null to fall through. */
export function mapInfrastructureError(error: unknown): ApiError | null {
  switch (classifyInfrastructureError(error)) {
    case 'tenant_isolation_violation':
      return new TenantIsolationViolationError(error)
    case 'database_unavailable':
      return new DatabaseUnavailableError()
    case 'tenant_scope_conflict':
      return new InternalServerError()
    default:
      return null
  }
}
