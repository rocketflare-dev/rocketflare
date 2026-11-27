/**
 * Application configuration: one zod schema over the Worker `env` object,
 * validated lazily and memoised per isolate by env identity. Called from `fetch` (via
 * `configMiddleware`), `queue` and `scheduled` so all three entry points fail identically.
 *
 * Only vars/secrets live here; bindings (HYPERDRIVE, RATE_LIMIT_KV, ASSETS, ...) stay on
 * `c.env`. Nothing in `src/` reads `process.env` — the source is the env object Cloudflare
 * hands us.
 */
import {
  brandAssetUrlSchema,
  loginPanelArtSchema,
  taglineSchema,
} from '@rocketflare/shared/branding'
import { sharedPlugins } from '@rocketflare/shared/plugins'
import { z } from 'zod'

/** `wrangler dev` passes `KEY=` lines from .dev.vars as empty strings; treat those as unset. */
const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional()
  )

const optionalString = blankAsUnset(z.string().min(1))

const optionalSecret = (min: number) => blankAsUnset(z.string().min(min))

/** A blank-or-absent enum var, for the ones whose ABSENCE means something (auto-detect). */
const optionalEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  blankAsUnset(z.enum(values as unknown as [T[number], ...T[number][]]))

/** `[vars]` arrive as strings; blank means "use the default", never 0. */
const optionalPositiveInt = (fallback: number) =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? fallback : value,
    z.coerce.number().int().positive()
  )

/** A cap that is OFF unless set: blank or absent → undefined, never 0 (budgets). */
const optionalCap = (kind: 'int' | 'number') =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    (kind === 'int' ? z.coerce.number().int() : z.coerce.number()).positive().optional()
  )

/** `[vars]` arrive as strings: `"false"` / `"0"` / `"no"` are false, blank is the default. */
const optionalBoolean = (fallback: boolean) =>
  z.preprocess(value => {
    if (value === undefined || value === null || String(value).trim() === '') return fallback
    if (typeof value === 'boolean') return value
    return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase())
  }, z.boolean())

/**
 * A comma-separated list of lowercase identifiers (feature keys). `csvList` below coerces to email
 * addresses, which is right for `BOOTSTRAP_ADMIN_EMAILS` and wrong for anything else.
 */
const csvKeys = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string())
)

const csvList = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : (value ?? []),
  z.array(z.string().email())
)

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

const coreConfigSchema = z.object({
  // ---- [vars] (non-secret, wrangler.toml) -------------------------------------------------
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Public origin; derives OAuth redirect URIs, magic-link URLs, CSRF/CORS allow-lists. */
  APP_URL: z.string().url(),
  APP_NAME: z.string().min(1).default('Rocketflare'),
  /** The one line under the name on the type-only sign-in panel; unset → the bundled line. */
  APP_TAGLINE: blankAsUnset(taglineSchema),
  /** What the sign-in panel shows (`rocket` drawing or `type`); unset → the bundled choice. */
  LOGIN_PANEL_ART: blankAsUnset(loginPanelArtSchema),
  /** The mark and the tab icon: `https://…` or a root-relative path; unset → the bundled one. */
  APP_LOGO_URL: blankAsUnset(brandAssetUrlSchema),
  APP_FAVICON_URL: blankAsUnset(brandAssetUrlSchema),
  /** Overridden at deploy time by CI (`wrangler deploy --var RELEASE_VERSION:<tag>`). */
  RELEASE_VERSION: z.string().min(1).default('dev'),
  /**
   * Unique per deploy, passed by the deploy scripts and CI (`wrangler deploy --var
   * DEPLOYMENT_ID:<id>`); undeclared in the tomls. A public site's page cache is keyed on it, so
   * new code is never hidden behind a page an older deploy stored. Missing → `RELEASE_VERSION`.
   */
  DEPLOYMENT_ID: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  EMAIL_FROM: z.string().min(1).default('Rocketflare <noreply@example.com>'),
  /** Schema is identical in both modes; `single` disables the multi-org surface. */
  TENANCY_MODE: z.enum(['multi', 'single']).default('multi'),
  /** Who may create an account. */
  SIGNUP_MODE: z.enum(['open', 'invite_only', 'approval']).default('invite_only'),
  /** `enforce` wraps tenant-scoped work in a transaction with `set_config(..., true)`. */
  TENANT_SCOPE_MODE: z.enum(['off', 'enforce']).default('off'),
  /**
   * `neon` (Neon serverless: HTTP queries, a WebSocket pool for transactions, needs the
   * `DATABASE_URL` secret) or `postgres` (postgres.js via the `HYPERDRIVE` binding, any Postgres).
   * Missing means `postgres`, so a copy that never set it is unchanged. `.dev.vars` overrides the
   * toml locally — the bootstrap writes `postgres` there.
   */
  DATABASE_DRIVER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.enum(['neon', 'postgres']).default('postgres')
  ),
  /**
   * Where the langfuse preset sends spans when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset —
   * `<base>/api/public/otel`.
   */
  LANGFUSE_BASE_URL: z.string().url().default('https://cloud.langfuse.com'),
  /** `deployment.environment.name` on every exported span; defaults to `APP_ENV`. */
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  /**
   * The OTLP/HTTP base URL spans are POSTed to (`/v1/traces` is appended). Unset + Langfuse
   * keys → Langfuse Cloud; unset otherwise → no export (the local `ai_spans` store still records).
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  /** `http/json` (default) or `http/protobuf` (the phoenix preset's default — Phoenix takes nothing else). */
  OTEL_EXPORTER_OTLP_PROTOCOL: optionalEnum(['http/json', 'http/protobuf']),
  /**
   * Which backend's auth and headers to fill in. Unset → `langfuse` when both Langfuse keys
   * are set (existing deployments migrate with no new secret), else `generic`.
   */
  OBSERVABILITY_PRESET: optionalEnum(['langfuse', 'phoenix', 'generic']),
  /** Off by default. `true` records prompts, completions and tool I/O in the export AND `ai_spans`. */
  OBSERVABILITY_CAPTURE_CONTENT: optionalBoolean(false),
  /** Link-out template, `{traceId}` substituted — e.g. `https://cloud.langfuse.com/project/<id>/traces/{traceId}`. */
  OBSERVABILITY_TRACE_URL: optionalString,
  /** Days of `ai_spans` the nightly prune keeps. */
  OBSERVABILITY_SPAN_RETENTION_DAYS: optionalPositiveInt(14),
  /**
   * Days of `plugin_events` the nightly prune keeps (D42). Short on purpose: a payload may hold
   * personal data (a form's fields), and a delivery's retries end within the hour.
   */
  EVENTS_RETENTION_DAYS: optionalPositiveInt(7),
  /**
   * Days a SETTLED agent run keeps its tool-loop journal (`agent_run_turns` — every model turn and
   * tool result), which is what a strict replay answers from. Runs, events and decisions are kept.
   */
  AGENT_TRANSCRIPT_RETENTION_DAYS: optionalPositiveInt(30),
  /** Per-call `max_tokens` when a tenant config sets none; and the tool-loop turn cap. */
  AGENT_MAX_OUTPUT_TOKENS: optionalPositiveInt(16384),
  AGENT_MAX_TURNS: optionalPositiveInt(30),
  /**
   * Runs one tenant may have queued, running or parked at once, across every agent. The
   * 51st enqueue is a 429 `agent_runs_limit`. A soft cap — counted, then inserted — so a burst of
   * simultaneous requests can overshoot it by a few; it exists to stop a runaway loop or a
   * mistaken batch, not to meter.
   */
  AGENT_MAX_ACTIVE_RUNS_PER_TENANT: optionalPositiveInt(50),
  /** Organisations one person may own (403 `tenant_limit_reached` above it); global admins exempt. */
  MAX_OWNED_TENANTS_PER_USER: optionalPositiveInt(10),
  /** Invitation emails one person may queue per UTC day, across every tenant (429 above it). */
  INVITATION_EMAILS_PER_USER_PER_DAY: optionalPositiveInt(500),
  /** Invitation emails one tenant may queue per UTC day, whoever sends them (429 above it). */
  INVITATION_EMAILS_PER_TENANT_PER_DAY: optionalPositiveInt(1000),
  /**
   * The MCP server (`/mcp`, when the deployment ships the `mcp` feature). A connection lapses
   * after `MCP_GRANT_IDLE_DAYS` without a call or `MCP_GRANT_MAX_DAYS` after it was made, whichever
   * comes first; the call log keeps `MCP_CALL_RETENTION_DAYS`. Tool calls are capped per minute
   * per connection, per person in an organisation (across all their connections) and per
   * organisation — over a cap the call answers a tool error the client's model can read, never a
   * 429 that some clients treat as a dead server. The person's cap is twice one connection's, so
   * someone running two clients at once is not slowed, and a fifth of the organisation's, so no
   * single member can spend its whole minute.
   */
  MCP_GRANT_IDLE_DAYS: optionalPositiveInt(30),
  MCP_GRANT_MAX_DAYS: optionalPositiveInt(90),
  MCP_CALL_RETENTION_DAYS: optionalPositiveInt(90),
  MCP_CALLS_PER_GRANT_PER_MINUTE: optionalPositiveInt(60),
  MCP_CALLS_PER_USER_PER_MINUTE: optionalPositiveInt(120),
  MCP_CALLS_PER_TENANT_PER_MINUTE: optionalPositiveInt(600),
  /**
   * What one run may spend — tokens (input, output and prompt-cache reads and writes, every call
   * and decision) and USD. Unset = no cap. An agent's `meta.budget` overrides either. Checked before
   * every metered call; a run over it fails with event code `agent_budget_exceeded`, and so does a
   * chat call on a model with no known price while a cost cap applies.
   */
  AGENT_RUN_MAX_TOKENS: optionalCap('int'),
  AGENT_RUN_MAX_COST_USD: optionalCap('number'),
  /**
   * What one tenant's agent runs may spend per UTC day, in USD. Unset = no cap. Checked at
   * enqueue (429 `ai_budget_exceeded`) and before every metered call of a run already going.
   */
  AGENT_TENANT_DAILY_COST_USD: optionalCap('number'),
  /**
   * What one tenant's KNOWLEDGE work — document and query embeddings, reranking and (phase 2)
   * fact extraction — may spend per UTC day, in USD. Unset = no cap. Only extraction pauses at it
   * (`knowledgeExtractionAllowed`); indexing and search never do, because search must keep working.
   */
  KNOWLEDGE_TENANT_DAILY_COST_USD: optionalCap('number'),
  /**
   * Drop a reranked search hit whose reranker score (0–1, every reranker on that scale) is below
   * this. Unset = off: the reranker reorders and nothing is dropped. No effect without a reranker.
   */
  /**
   * How many fused candidates go to the reranker (5–100; unset = 20). The reranker's latency grows
   * with it — on the kit fixture, qwen3-reranker-8b took a median 810 ms for 50 chunks and 465 ms
   * for 20, at the same recall — and a corpus whose answers sit deeper in the fused order may want
   * more; set it from `RERANK_CANDIDATES=… pnpm eval retrieval --rerank …` (docs/EVALS.md).
   */
  RERANK_CANDIDATES: z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    z.coerce.number().int().min(5).max(100).optional()
  ),
  RERANK_MIN_SCORE: z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    z.coerce.number().min(0).max(1).optional()
  ),
  /**
   * Give the chat box the knowledge tools (`search_knowledge`, `get_document`,
   * `list_documents`), so it answers from the workspace's own material. It costs more tokens per
   * turn and, on Workers AI — which has no tool-call event stream — the reply stops arriving token
   * by token. `false` is the operator's way back to a tool-free chat.
   */
  CHAT_KNOWLEDGE_TOOLS: optionalBoolean(true),
  /**
   * Issue #17: how long a run parked on a human question waits before it expires. Consumed
   * VERBATIM as the `timeout` of `step.waitForEvent`, so it must be a duration string Cloudflare
   * Workflows accepts ("168 hours", "30 minutes", "7 days") — not a number of seconds.
   *
   * Workflows allows 1 second to 365 days here and a `waiting` instance does not count toward
   * concurrency, so parking really is free. The real bound is **instance retention**: 30 days on
   * Workers Paid but only 3 days on Free, and a run parked past retention loses its instance, so
   * `waitForEvent` never fires and only the read-path expiry sweep recovers it. Keep this under
   * 3 days if you are not on Workers Paid.
   */
  AGENT_INTERRUPT_TIMEOUT: z.string().min(1).default('168 hours'),
  /**
   * Characters of stored history a chat turn may replay. The real constraint is the model's
   * context window and the tenant picks the model, so this is the knob rather than a message count
   * — 24 000 chars is roughly 6 000 tokens, which leaves room on the 24k-token Workers AI floor.
   * Raise it for a long-context provider. Anything older is trimmed and folded into the thread's
   * rolling summary by the `chat.compact` job.
   */
  CHAT_HISTORY_MAX_CHARS: optionalPositiveInt(24_000),
  /**
   * Layer 1: the feature keys this deployment ships AT ALL. Only consulted for a flag whose
   * registry entry sets `environmentGated` — everything else is decided by the rollout state in the
   * database, so an ordinary flag needs no toml edit.
   *
   * Blank means none, which is the FAIL-CLOSED direction and the point: this gate's failure mode is
   * an unreleased surface appearing in production, so an environment that forgets the var stays
   * dark. Note `wrangler dev` reads `[vars]` from `wrangler.toml`, so a key listed only in staging
   * is absent on every developer's laptop unless `.dev.vars` overrides it — which is why
   * `.dev.vars.example` lists the built-in gated keys.
   */
  FEATURES_ENABLED: csvKeys,
  /**
   * Generic OpenID Connect sign-in (`providers/oidc.ts`). Unset → no `oidc` provider, the login
   * page is exactly what it was. Set it to the issuer's `issuer` value VERBATIM (trailing slash
   * included when the issuer has one) — discovery must echo it back or sign-in is refused.
   */
  OIDC_ISSUER: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  OIDC_CLIENT_ID: optionalString,
  /** Button text on the login page ("Sign in with …" is the UI's, not this). */
  OIDC_LABEL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('Single sign-on')
  ),
  /** Space-separated; `openid` is always sent whether listed or not. */
  OIDC_SCOPES: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('openid email profile')
  ),
  /**
   * `true` → the login page redirects straight to the OIDC issuer and hides the other methods, and
   * `/auth/google|microsoft` refuse to start. Hides, not disables: the magic-link endpoint stays
   * live for invitations. Requires `OIDC_ISSUER` + `OIDC_CLIENT_ID` (a config error otherwise).
   */
  AUTH_OIDC_ONLY: optionalBoolean(false),
  /**
   * Secure default `false`: an OIDC issuer that omits `email_verified` is not trusted for its
   * email (the sign-in is refused as `email_unverified`). `true` treats a MISSING flag as verified
   * — only for an issuer that controls the `email` claim (single-tenant Entra). An explicit
   * `email_verified: false` is refused either way.
   */
  OIDC_TRUST_EMAIL: optionalBoolean(false),
  /**
   * `true` → the OIDC issuer manages tenancy (IdP-managed tenancy, `api/services/idp-tenancy.ts`,
   * docs/CONCEPTS.md §2): every OIDC sign-in reconciles tenants, memberships and the global-admin
   * flag from the verified id_token, admission comes from those claims rather than `SIGNUP_MODE`,
   * an OIDC session ends `OIDC_SESSION_MAX_AGE_DAYS` after sign-in however active it is, and the
   * issuer's identity events are applied between sign-ins (`IDENTITY_WEBHOOK_SECRET`). Requires
   * `OIDC_ISSUER` + `OIDC_CLIENT_ID` and `TENANCY_MODE=multi`.
   */
  OIDC_MANAGED_TENANCY: optionalBoolean(false),
  /** The id_token claim holding the person's orgs: `[{ id, name, slug?, role }]`. */
  OIDC_ORGS_CLAIM: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).default('orgs')
  ),
  /**
   * Issuer role → app role, as `issuerRole:appRole` pairs separated by commas; the app role is
   * `admin` or `member`. An org whose role is not listed is skipped (and logged). Default: the
   * issuer's `admin` and `member` mean the same here.
   */
  OIDC_ROLE_MAP: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .default('admin:admin,member:member')
      .transform((text, ctx) => {
        const map: Record<string, 'admin' | 'member'> = {}
        for (const pair of text
          .split(',')
          .map(p => p.trim())
          .filter(Boolean)) {
          const [from, to, ...rest] = pair.split(':').map(p => p.trim())
          if (!from || (to !== 'admin' && to !== 'member') || rest.length > 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${pair}" is not issuerRole:admin or issuerRole:member`,
            })
            return z.NEVER
          }
          map[from] = to
        }
        return map
      })
  ),
  /**
   * A boolean id_token claim that admits the person even with no orgs (staff who may use every
   * app, say). Unset → only a person with an org, or a global admin, is admitted by the claims.
   */
  OIDC_ADMIT_CLAIM: optionalString,
  /**
   * A boolean id_token claim that makes the person a global admin while it is true. Unset → the
   * claims never grant global admin.
   */
  OIDC_GLOBAL_ADMIN_CLAIM: optionalString,
  /**
   * Under `OIDC_MANAGED_TENANCY`, an OIDC session ends this many days after sign-in, however active
   * the person is, so everyone is reconciled from fresh claims at least this often. Keep it no
   * longer than the issuer keeps undelivered identity events. At most 30, the cookie's own life: the
   * cookie is set once, at sign-in.
   */
  OIDC_SESSION_MAX_AGE_DAYS: z.preprocess(
    value => (value === undefined || value === null || String(value).trim() === '' ? 7 : value),
    z.coerce.number().int().positive().max(30)
  ),

  // ---- Secrets (.dev.vars locally, `wrangler secret put` deployed) — all optional here;
  //      features gate on presence (zero-creds first run) or demand them at use time. -------
  /**
   * The owner connection string. Under `neon` it is THE connection (the pooled Neon URI, a Worker
   * secret); under `postgres` the fallback when there is no HYPERDRIVE binding (local, tests).
   */
  DATABASE_URL: optionalString,
  /** Per-PR Neon branch; when set it wins over HYPERDRIVE and DATABASE_URL (see db/client.ts). */
  PREVIEW_DATABASE_URL: optionalString,
  /**
   * Local only: the Neon proxy in front of the compose Postgres (`http://localhost:4444`),
   * written by `pnpm dev:db:up --neon`. Never set in a deployed environment.
   */
  NEON_LOCAL_PROXY: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional()
  ),
  /** AES-GCM key for OAuth tokens at rest. */
  OAUTH_ENCRYPTION_KEY: optionalSecret(32),
  /**
   * The issuer's identity-event signing secret (Standard Webhooks, `whsec_…`). Set under
   * `OIDC_MANAGED_TENANCY` → `POST /api/identity/events` accepts events signed with it; unset → that
   * route answers 404.
   */
  IDENTITY_WEBHOOK_SECRET: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/, 'a Standard Webhooks secret: whsec_ and base64')
      .optional()
  ),
  RESEND_API_KEY: optionalString,
  /**
   * Direct-to-storage uploads (`services/uploads`): the account whose R2 S3 API signs the `PUT`
   * URLs, and the S3 name of the `FILES` bucket (the binding cannot tell the Worker its own name).
   * Both are `[vars]`; the key pair is a secret, from an R2 API token scoped to the app's buckets.
   * Without all four, uploads go through a `PUT` on the Worker itself (`/api/upload-content/:id`)
   * — in `development` and deployed alike; a deployed Worker takes at most 10 MB a file that way.
   */
  R2_ACCOUNT_ID: optionalString,
  FILES_BUCKET_NAME: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  /** Comma-separated emails promoted to global admin on first VERIFIED login. */
  BOOTSTRAP_ADMIN_EMAILS: csvList,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  /** Optional: a PUBLIC client (PKCE only) has none. Sent as HTTP Basic (`client_secret_basic`). */
  OIDC_CLIENT_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  EMBEDDINGS_API_KEY: optionalString,
  /** Platform TypeSafe (Jev) key for `ctx.decide`; tenants may set their own in Settings → AI. */
  TYPESAFE_API_KEY: optionalString,
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
  /** Extra OTLP request headers, `k=v,k=v` (values URL-encoded, per the OTel spec). A secret. */
  OTEL_EXPORTER_OTLP_HEADERS: optionalString,
})

/**
 * `[vars]` and secrets contributed by installed plugins, validated with everything else so a
 * plugin with a missing var fails at `loadConfig` rather than at its first request.
 *
 * `AppConfig` stays the CORE type on purpose, and the cast is what holds that line: `extend()` over
 * a `ZodRawShape` collapses the inferred shape to an index signature, which would turn every core
 * key into `any`. A plugin reads its own keys through its own narrowing helper — one plugin's vars
 * can never widen, or weaken, the type core is checked against.
 */
const pluginConfigShape: z.ZodRawShape = Object.assign(
  {},
  ...sharedPlugins.map(p => p.config ?? {})
)
const configSchema = coreConfigSchema.extend(pluginConfigShape).superRefine((cfg, ctx) => {
  // An OIDC-only login page with no issuer would offer no way in at all.
  if (cfg.AUTH_OIDC_ONLY && !(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_OIDC_ONLY'],
      message: 'AUTH_OIDC_ONLY=true needs OIDC_ISSUER and OIDC_CLIENT_ID',
    })
  }
  // A Neon deployment has no HYPERDRIVE fallback: fail here, not on the first query.
  if (cfg.DATABASE_DRIVER === 'neon' && !(cfg.DATABASE_URL || cfg.PREVIEW_DATABASE_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_URL'],
      message: 'DATABASE_DRIVER=neon needs the DATABASE_URL secret (the pooled Neon URI)',
    })
  }
  // Managed tenancy reads the issuer's id_token — without an issuer it reads nothing.
  if (cfg.OIDC_MANAGED_TENANCY && !(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_MANAGED_TENANCY'],
      message: 'OIDC_MANAGED_TENANCY=true needs OIDC_ISSUER and OIDC_CLIENT_ID',
    })
  }
  // One tenant per issuer org: single-tenant mode has exactly one, so the two cannot both hold.
  if (cfg.OIDC_MANAGED_TENANCY && cfg.TENANCY_MODE === 'single') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OIDC_MANAGED_TENANCY'],
      message:
        'OIDC_MANAGED_TENANCY=true needs TENANCY_MODE=multi (it creates one tenant per issuer org); ' +
        'single-tenant mode signs OIDC users into its one tenant without it — unset it',
    })
  }
}) as unknown as typeof coreConfigSchema

export type AppConfig = z.infer<typeof coreConfigSchema>
export type AppEnvName = AppConfig['APP_ENV']
export type OAuthProviderName = 'google' | 'microsoft' | 'oidc'

/** Thrown by `loadConfig`; the message lists every missing/invalid key. */
export class ConfigError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    const details = issues.map(issue => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n')
    super(`Invalid environment configuration:\n${details}`)
    this.name = 'ConfigError'
  }
}

/**
 * Memo keyed on the env OBJECT, not its contents: in production `env` is one object for the
 * life of the isolate, so this parses once; in `wrangler dev` a .dev.vars edit yields a new
 * object and re-validates. Failures are not cached so every caller sees the same error.
 */
const cache = new WeakMap<object, AppConfig>()

export function loadConfig(env: unknown): AppConfig {
  const key = typeof env === 'object' && env !== null ? env : undefined
  if (key) {
    const hit = cache.get(key)
    if (hit) return hit
  }
  const result = configSchema.safeParse(env ?? {})
  if (!result.success) throw new ConfigError(result.error.issues)
  if (key) cache.set(key, result.data)
  return result.data
}

// ---- Derived helpers ---------------------------------------------------------------------

export const isProduction = (cfg: AppConfig): boolean => cfg.APP_ENV === 'production'
export const isDevelopment = (cfg: AppConfig): boolean => cfg.APP_ENV === 'development'

/** `{APP_URL}/auth/{provider}/callback` — never configured per provider. */
export function oauthRedirectUri(cfg: AppConfig, provider: OAuthProviderName): string {
  return new URL(`/auth/${provider}/callback`, cfg.APP_URL).toString()
}

/** Without a Resend key, magic links are logged instead of sent (zero-creds first run). */
export const hasEmail = (cfg: AppConfig): boolean => Boolean(cfg.RESEND_API_KEY)

/** The R2 S3 API key pair and account, when all are set — what presigning an upload needs. */
export function r2SigningCredentials(
  cfg: AppConfig
): { accountId: string; accessKeyId: string; secretAccessKey: string } | null {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId } = cfg
  const secretAccessKey = cfg.R2_SECRET_ACCESS_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) return null
  return { accountId, accessKeyId, secretAccessKey }
}

/** Providers whose client id AND secret are both present — the login page shows only these. */
export function configuredOAuthProviders(cfg: AppConfig): OAuthProviderName[] {
  const providers: OAuthProviderName[] = []
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) providers.push('google')
  if (cfg.MICROSOFT_CLIENT_ID && cfg.MICROSOFT_CLIENT_SECRET) providers.push('microsoft')
  if (hasOidc(cfg)) providers.push('oidc')
  return providers
}

/** An OIDC issuer is configured — issuer + client id (the secret is optional: public clients). */
export const hasOidc = (cfg: AppConfig): boolean => Boolean(cfg.OIDC_ISSUER && cfg.OIDC_CLIENT_ID)

/** IdP-managed tenancy in force (loadConfig has already refused it without an issuer). */
export const isIdpManaged = (cfg: AppConfig): boolean => cfg.OIDC_MANAGED_TENANCY && hasOidc(cfg)

/** `AUTH_OIDC_ONLY` in force (loadConfig has already refused it without an issuer). */
export const isOidcOnly = (cfg: AppConfig): boolean => cfg.AUTH_OIDC_ONLY && hasOidc(cfg)
