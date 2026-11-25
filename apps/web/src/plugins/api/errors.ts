/**
 * The host's HTTP error classes, for code a plugin runs outside a route — a tool handler, a job,
 * an agent step — where there is no `RequestCtx` and so no `ctx.notFound()` / `ctx.forbidden()`.
 *
 * Each serialises to the shared envelope `{ error, statusCode, code?, details? }`. On a route the
 * error handler turns it into that response; in a tool the MCP server answers
 * `{ error: code, message }` as a tool error, so the message is text the client's model reads:
 * no SQL, no stack, no internal names. Inside a route, prefer the `ctx` helpers — same classes.
 * Pass a stable code (`ERROR_CODES` from `@rocketflare/shared/errors`, or `<your id>_…`).
 */
export {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  isApiError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '../../api/utils/core/errors'
