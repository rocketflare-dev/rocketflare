/**
 * KV sliding-window rate limiting + per-tenant operation lock (D14). Keyed by client IP
 * (`cf-connecting-ip`, falling back to `x-forwarded-for`) and route name; a no-op when the
 * `RATE_LIMIT_KV` binding is absent. KV's read-modify-write is not atomic and KV is eventually
 * consistent, so the limit is approximate — right for login throttling, not for billing.
 * Applied PER MOUNT in `index.ts` / `routes/auth/index.ts`, never inside a handler.
 */
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { ConflictError, RateLimitedError } from '../utils/core/errors'

export interface RateLimitOptions {
  /** Distinguishes routes sharing one IP; part of the KV key. */
  name: string
  max: number
  windowSeconds: number
}

/** Minimal KV surface — `KVNamespace` in production, `MemoryKV` in tests. */
export interface RateLimitKv {
  get(key: string, type: 'json'): Promise<unknown>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/** Pure check: read the window, drop stale hits, decide, write back. */
export async function checkRateLimit(
  kv: RateLimitKv,
  key: string,
  options: Pick<RateLimitOptions, 'max' | 'windowSeconds'>
): Promise<RateLimitDecision> {
  const now = Date.now()
  const windowMs = options.windowSeconds * 1000
  const raw = (await kv.get(key, 'json')) as number[] | null
  const hits = (raw ?? []).filter(t => typeof t === 'number' && now - t < windowMs)
  if (hits.length >= options.max) {
    const oldest = Math.min(...hits)
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    }
  }
  hits.push(now)
  // KV enforces a 60s minimum TTL; the window filter above is what actually bounds the count.
  await kv.put(key, JSON.stringify(hits), { expirationTtl: Math.max(60, options.windowSeconds) })
  return { allowed: true, remaining: options.max - hits.length, retryAfterSeconds: 0 }
}

export function clientIp(headers: { get(name: string): string | null | undefined }): string {
  return (
    headers.get('cf-connecting-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

export function rateLimit(options: RateLimitOptions) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const kv = c.env.RATE_LIMIT_KV as RateLimitKv | undefined
    if (!kv) return next()
    const ip = clientIp({ get: name => c.req.header(name) })
    const decision = await checkRateLimit(kv, `rl:${options.name}:${ip}`, options)
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds))
      throw new RateLimitedError(
        'Too many requests, please try again later',
        decision.retryAfterSeconds
      )
    }
    await next()
  })
}

/** 10 requests / minute / IP — magic-link request, dev-login, OAuth start, invite accept. */
export const authRateLimit = rateLimit({ name: 'auth', max: 10, windowSeconds: 60 })

/**
 * Per-tenant mutex on the same KV: `operationLock(kv, 'tenant:delete:<id>', fn)`. A second
 * caller while `fn` runs gets 409 `operation_in_progress`; the TTL is the crash safety net.
 * With no KV (local dev without the binding) `fn` simply runs.
 */
export async function operationLock<T>(
  kv: RateLimitKv | undefined,
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = 600
): Promise<T> {
  if (!kv) return fn()
  const lockKey = `op_lock:${key}`
  if ((await kv.get(lockKey, 'json')) !== null) {
    throw new ConflictError('Operation already in progress', 'operation_in_progress')
  }
  await kv.put(lockKey, JSON.stringify({ startedAt: Date.now() }), {
    expirationTtl: Math.max(60, ttlSeconds),
  })
  try {
    return await fn()
  } finally {
    await kv.delete(lockKey).catch(() => {})
  }
}
