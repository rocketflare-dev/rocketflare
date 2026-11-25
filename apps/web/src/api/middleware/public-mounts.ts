/**
 * The host's guards on a plugin's PUBLIC mounts (`ServerPlugin.publicMounts`, `/api/hooks/<id>`):
 * hostile-internet endpoints with no session, so the host — not each handler — throttles and
 * size-caps them. Two halves, because they run at two points of the middleware order:
 *
 *   - the body cap is chosen at step 5 (`apiBodyLimit(publicBodyLimitOverrides(mounts))`), before
 *     any parsing or DB work, exactly where the 1 MB JSON cap runs;
 *   - the rate limit is applied PER MOUNT by `mountPublicRoutes`, like `authRateLimit` — a per-IP
 *     KV window named after the prefix, default `PUBLIC_MOUNT_RATE_LIMIT`, `false` to turn it off.
 *
 * `api/index.ts` and `tests/config/public-mounts.test.ts` call the same two functions, so the
 * test exercises the wiring rather than a copy of it.
 */
import type { Hono, MiddlewareHandler } from 'hono'
import type { PluginPublicMount } from '../../plugins/types'
import type { AppEnv } from '../types'
import { type BodyLimitOverride, isUnderPrefix } from './body-limit'
import { rateLimit } from './rate-limit'

/**
 * 120 requests / 60 s / IP — two a second sustained is generous for a consent callback, a SAML
 * ACS or a SCIM client, and still bounds what one address can make the handler verify.
 */
export const PUBLIC_MOUNT_RATE_LIMIT = { max: 120, windowSeconds: 60 } as const

/** The bucket a public mount's limiter writes, so two plugins (or two prefixes) never share one. */
export function publicMountRateLimitName(prefix: string): string {
  return `hooks:${prefix}`
}

/** Each public mount that declared `bodyLimitBytes`, for `apiBodyLimit` at step 5. */
export function publicBodyLimitOverrides(
  mounts: readonly PluginPublicMount[]
): BodyLimitOverride[] {
  return mounts.flatMap(([prefix, , options]) =>
    options?.bodyLimitBytes === undefined ? [] : [{ prefix, maxBytes: options.bodyLimitBytes }]
  )
}

/**
 * Mount every public router with its rate limit in front. A path is throttled by the LONGEST
 * public prefix it falls under only, so a nested mount (`/api/hooks/x/scim` beneath
 * `/api/hooks/x`) is counted once, in its own bucket, under its own options.
 */
export function mountPublicRoutes(app: Hono<AppEnv>, mounts: readonly PluginPublicMount[]): void {
  const prefixes = mounts.map(m => m[0]).sort((a, b) => b.length - a.length)
  const ownerOf = (path: string) => prefixes.find(p => isUnderPrefix(path, p))
  // Every limiter BEFORE any router: Hono runs matches in registration order, so a parent
  // router's catch-all registered first would answer before a nested mount's limiter ran.
  for (const [prefix, , options] of mounts) {
    const limit = options?.rateLimit ?? PUBLIC_MOUNT_RATE_LIMIT
    if (limit === false) continue
    const limiter = rateLimit({
      name: publicMountRateLimitName(prefix),
      max: limit.max,
      windowSeconds: limit.windowSeconds,
    })
    const guard: MiddlewareHandler<AppEnv> = (c, next) =>
      ownerOf(c.req.path) === prefix ? limiter(c, next) : next()
    app.use(prefix, guard)
    app.use(`${prefix}/*`, guard)
  }
  for (const [prefix, router] of mounts) app.route(prefix, router)
}
