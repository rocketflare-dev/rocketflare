/**
 * pino factory for every context (D16). Request logging goes through hono-pino
 * (`middleware/request-logger.ts`) which wraps a logger from here; queue/scheduled/scripts call
 * `createLogger` directly. Workers have no stdout: pino's `browser` mode writes structured
 * objects via `console.*`, which `[observability.logs]` ships as JSON. In `APP_ENV=development`
 * the `hono-pino/debug-log` writer pretty-prints instead (the Workers reference app's proven config).
 */
import { createHandler as debugLog } from 'hono-pino/debug-log'
import pino from 'pino'
import type { AppConfig } from '../../../config'

export type Logger = pino.Logger
export type LogLevel = AppConfig['LOG_LEVEL']

export interface LoggerOptions {
  level: LogLevel
  /** Human-readable output (development only). */
  pretty?: boolean
  /** Fields attached to every line, e.g. `{ env, release }`. */
  base?: Record<string, unknown>
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: options.base ?? {},
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    browser: {
      asObject: true,
      ...(options.pretty
        ? {
            write: debugLog({
              colorEnabled: true,
              normalLogFormat: '[{time}] {levelLabel} - {msg} {bindings}',
              bindingsFormatter: bindings =>
                bindings && Object.keys(bindings).length > 0 ? JSON.stringify(bindings) : '',
              timeFormatter: time =>
                time
                  ? new Date(time).toLocaleTimeString('en-GB', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })
                  : '',
            }),
          }
        : {}),
    },
  })
}

/** Logger options derived from validated config — the one mapping every entry point uses. */
export function loggerOptionsFor(
  cfg: AppConfig,
  extra: Record<string, unknown> = {}
): LoggerOptions {
  return {
    level: cfg.LOG_LEVEL,
    pretty: cfg.APP_ENV === 'development',
    base: { env: cfg.APP_ENV, release: cfg.RELEASE_VERSION, ...extra },
  }
}

/** Convenience for non-request contexts: `loggerFor(cfg, { handler: 'scheduled' })`. */
export function loggerFor(cfg: AppConfig, extra: Record<string, unknown> = {}): Logger {
  return createLogger(loggerOptionsFor(cfg, extra))
}
