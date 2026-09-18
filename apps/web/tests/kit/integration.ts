/**
 * `@testkit/integration` — the host's test harness, as a DECLARED entry (D31).
 *
 * Before this existed, both installed plugins reached the harness through six-level relative climbs
 * (`../../../../../tests/helpers/auth`): five modules and twenty-one symbols, none of them declared,
 * none of them covered by anybody's semver. That is the same coupling the plugin API removed from a
 * plugin's SOURCE, and it was left out of the rule only because there was nowhere to point it.
 * There is now, so a plugin's tests are in scope for the rule like everything else.
 *
 * **Two entries, split by what a test needs rather than by which project it runs in.** This one is
 * the harness: a real database, the real Hono app, real bindings-shaped stubs, and the UI's provider
 * tree. `@testkit/unit` is the other — builders for the plugin context family, for tests that never
 * touch data. The names below are re-exports, so the kit's own helpers stay the single
 * implementation and a plugin and a kit test are running the same code.
 *
 * **It is registered in `tsconfig.json` and `vitest.config.ts` and DELIBERATELY NOT in
 * `vite.config.ts`.** A `src/` file that imports `@testkit` therefore fails the build rather than
 * shipping the harness — `@testing-library/react`, the seed fixtures, a Postgres client — into
 * somebody's browser bundle. `tests/config/testkit-alias.test.ts` pins all three halves of that,
 * and scans `src/` directly, because a scan says which file is wrong where a failed build only says
 * that one is.
 */

// ---- the database ------------------------------------------------------------------------------

/**
 * The shared pooled handle, and the ONLY source of a `db` the `@testkit/unit` builders accept.
 * `safetyCheck()` inside it refuses anything but a localhost database under `NODE_ENV=test`.
 */
export { cleanDatabase, setupTestDatabase, testDatabaseUrl } from '../helpers/db'

// ---- bindings and the app ----------------------------------------------------------------------

/**
 * `request(path, init?, options?)` drives the REAL app through every middleware and drains
 * `waitUntil` before returning, so a deferred write has landed by the time an assertion runs.
 *
 * **A plugin's tenant-isolation case goes through here and nowhere else.** Driving the real mount as
 * a second tenant is what proves the predicate; a builder from `@testkit/unit` proves the branch.
 */
export { json, type RequestOptions, request } from '../helpers/request'
/**
 * `createTestEnv()` is `Cloudflare.Env`-shaped with in-memory stubs; `stubs(env)` is their
 * inspection surface (`queue.messages`, `files.objects`, `hub.broadcasts`, `ai.runs`,
 * `workflow.created`). Pass `{ JOBS_QUEUE: undefined }` and friends to exercise a missing binding.
 */
export {
  createExecutionContext,
  createTestEnv,
  type RecordedMessage,
  stubs,
  type TestEnv,
  waitOnExecutionContext,
} from '../mocks/bindings'

// ---- the cron dispatcher -----------------------------------------------------------------------

/**
 * The host's scheduled dispatcher, so a plugin can prove its task and the toml expression MET.
 *
 * A plugin declares the cron EXPRESSION in its `plugin.json` (which is what
 * `pnpm provision cloudflare <env>` copies into both tomls) and the TASK through
 * `ServerPlugin.scheduledTasks`. Those are two halves of a handshake, and the failure mode when
 * they disagree is silent: a task registered under an expression no toml carries simply never
 * runs, and nothing anywhere says so.
 *
 * `SCHEDULED_TASKS` is the merged registry — the kit's tasks plus every installed plugin's — and
 * `dispatchScheduled(cron, env, ctx)` runs the ones registered for that expression and returns a
 * report per task. So the assertion a plugin wants is one line: dispatch the expression the
 * manifest declares, and find your task's name in the report with `status: 'ok'`.
 *
 * Note what the report gives you that a direct call does not: a task that THREW is `'failed'`
 * rather than a rejected promise, because the dispatcher try/catches each task individually so one
 * plugin's failure cannot stop the kit's nightly prune. Asserting `'ok'` is therefore a real
 * assertion, not a formality.
 */
export {
  dispatchScheduled,
  SCHEDULED_TASKS,
  type ScheduledTask,
  type TaskReport,
} from '@/api/scheduled'

// ---- fixtures ----------------------------------------------------------------------------------

/**
 * Users, tenants, memberships, sessions and API keys, written the way production writes them —
 * credentials stored hashed, the raw value returned for the request. Every factory suffixes a
 * unique id, so files running in parallel never collide and nothing truncates between them.
 */
export {
  bearerHeader,
  createTestApiKey,
  createTestGlobalAdmin,
  createTestSession,
  createTestTenant,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  SESSION_COOKIE_NAME,
  sessionCookieHeader,
  type TestSeed,
  uniqueId,
} from '../helpers/auth'

// ---- the UI harness ----------------------------------------------------------------------------

/**
 * `renderWithProviders` mounts the same provider tree `App.tsx` does — QueryClient → Auth → Ability
 * → Router — so a plugin's page and nav item are exercised through the kit's REAL guards.
 *
 * That is the point of re-exporting it rather than letting a plugin build its own: an app on this
 * kit once wrote a nav test against a re-implementation of the guard, and the re-implementation is
 * what hid the bug it was meant to catch (a server gate reading the CASL ability, where a global
 * admin's `manage all` satisfies every `Feature:` subject). Anything that re-derives what the real
 * hook does is worthless.
 */
export {
  createTestQueryClient,
  errorResponse,
  IDS,
  jsonResponse,
  makeSession,
  makeTenant,
  makeUser,
  notFoundResponse,
  paged,
  type RouteTable,
  renderWithProviders,
  requestBody,
  rulesFor,
  stubFetch,
  stubHealthFetch,
  stubSessionFetch,
  unauthorizedResponse,
} from '../ui/helpers/renderWithProviders'
