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
 * `/cubejs-api` and `/mcp` are the drizzle-cube API (D19), `/ws` the realtime upgrade (Phase 2).
 *
 * A plugin (D31) may own a prefix OUTSIDE `/api` — a protocol endpoint, say. Those are unioned in
 * from the server barrel, which means installing such a plugin also means adding its patterns to
 * `run_worker_first` in BOTH tomls by hand: the parity test reads this list, so a forgotten one
 * fails the gate rather than silently serving the app shell.
 */
import { serverPlugins } from '../../../plugins/server'

const CORE_API_PREFIXES = ['/api', '/auth', '/cubejs-api', '/mcp', '/ws'] as const

export const API_PREFIXES: readonly string[] = [
  ...CORE_API_PREFIXES,
  ...serverPlugins.flatMap(p => p.apiPrefixes ?? []),
]

export function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * The same prefixes as wrangler asset-router patterns: each one exactly, and everything beneath it.
 * This is the value `[assets] run_worker_first` must hold in BOTH tomls.
 */
export const WORKER_FIRST_PATTERNS: string[] = API_PREFIXES.flatMap(p => [p, `${p}/*`])
