/**
 * The path prefixes the Worker owns, in ONE place, because two very different things read them.
 *
 * 1. The SPA catch-all in `api/index.ts`: an unmatched path under one of these is a JSON 404,
 *    never `index.html`.
 * 2. **`run_worker_first` in both wrangler tomls.** Cloudflare's static-asset router runs BEFORE
 *    the Worker, and `not_found_handling = "single-page-application"` answers anything it considers
 *    a navigation with `index.html` without invoking `fetch` at all. `Sec-Fetch-Mode: navigate` is
 *    not just the address bar — an `<object>`/`<iframe>` embed and an `<a download>` click are
 *    navigations too — so without `run_worker_first` these routes are silently served the app shell
 *    for exactly those requests. That is invisible to the test suite, which drives the Hono app
 *    directly and never goes near the asset router, so `wrangler-parity.test.ts` asserts the tomls
 *    mirror this list instead.
 *
 * `/ws` is the realtime upgrade. The analytics plugin adds `/cubejs-api` and `/mcp`.
 *
 * A plugin may own a prefix OUTSIDE `/api` — a protocol endpoint, say. Those are unioned in
 * from the server barrel, which means installing such a plugin also means adding its patterns to
 * `run_worker_first` in BOTH tomls by hand: the parity test reads this list, so a forgotten one
 * fails the gate rather than silently serving the app shell.
 */
import { serverPlugins } from '../../../plugins/server'

const CORE_API_PREFIXES = ['/api', '/auth', '/ws'] as const

export const API_PREFIXES: readonly string[] = [
  ...CORE_API_PREFIXES,
  ...serverPlugins.flatMap(p => p.apiPrefixes ?? []),
]

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * `run_worker_first` while an installed plugin serves public sites. The asset router ignores the
 * host, so a prefix list would answer `/about` on a site host with the app's `index.html`; instead
 * every request but the two hashed bundles (`/assets/*` for the admin UI, `/site-assets/*` for
 * public sites) reaches the Worker, and app navigations go through the SPA catch-all. Must equal the copy in `scripts/lib/plugin-lib.mjs`, which writes it into both tomls
 * (`wrangler-parity.test.ts` pins the two together).
 */
export const PUBLIC_SITES_WORKER_FIRST: readonly string[] = ['/*', '!/assets/*', '!/site-assets/*']

/** The value `[assets] run_worker_first` must hold in BOTH tomls for this set of prefixes. */
export function workerFirstPatterns(
  prefixes: readonly string[],
  hasPublicSites: boolean
): string[] {
  return hasPublicSites ? [...PUBLIC_SITES_WORKER_FIRST] : prefixes.flatMap(p => [p, `${p}/*`])
}

export const WORKER_FIRST_PATTERNS: string[] = workerFirstPatterns(
  API_PREFIXES,
  serverPlugins.some(p => p.publicSites)
)
