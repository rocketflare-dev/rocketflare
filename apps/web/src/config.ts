/**
 * Application configuration (D3, D4, D9, D25): one zod schema over the Worker `env` object,
 * validated lazily and memoised per isolate by env identity. Called from `fetch` (via
 * `configMiddleware`), `queue` and `scheduled` so all three entry points fail identically.
 *
 * Only vars/secrets live here; bindings (HYPERDRIVE, RATE_LIMIT_KV, ASSETS, ...) stay on
 * `c.env`. Nothing in `src/` reads `process.env` — the validation style is the Node reference app's
 * `src/config.ts`, the source is the env object Cloudflare hands us.
 */
import { z } from 'zod'

/** `wrangler dev` passes `KEY=` lines from .dev.vars as empty strings; treat those as unset. */
const optionalString = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().min(1).optional()
)

const optionalSecret = (min: number) =>
  z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(min).optional()
  )

/** `[vars]` arrive as strings; blank means "use the default", never 0. */
const optionalPositiveInt = (fallback: number) =>
  z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? fallback : value,
    z.coerce.number().int().positive()
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

const configSchema = z.object({
  // ---- [vars] (non-secret, wrangler.toml) -------------------------------------------------
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Public origin; derives OAuth redirect URIs, magic-link URLs, CSRF/CORS allow-lists. */
  APP_URL: z.string().url(),
  APP_NAME: z.string().min(1).default('Rocketflare'),
  /** Overridden at deploy time by CI (`wrangler deploy --var RELEASE_VERSION:<tag>`). */
  RELEASE_VERSION: z.string().min(1).default('dev'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  EMAIL_FROM: z.string().min(1).default('Rocketflare <noreply@example.com>'),
  /** D25: schema is identical in both modes; `single` disables the multi-org surface. */
  TENANCY_MODE: z.enum(['multi', 'single']).default('multi'),
  /** D9: who may create an account. */
  SIGNUP_MODE: z.enum(['open', 'invite_only', 'approval']).default('invite_only'),
  /** D1: `enforce` wraps tenant-scoped work in a transaction with `set_config(..., true)`. */
  TENANT_SCOPE_MODE: z.enum(['off', 'enforce']).default('off'),
  LANGFUSE_BASE_URL: z.string().url().default('https://cloud.langfuse.com'),
  /** Langfuse `environment` tag; defaults to `APP_ENV` at the tracer (D16). */
  LANGFUSE_TRACING_ENVIRONMENT: optionalString,
  /** D17: per-call `max_tokens` when a tenant config sets none; and the tool-loop turn cap. */
  AGENT_MAX_OUTPUT_TOKENS: optionalPositiveInt(16384),
  AGENT_MAX_TURNS: optionalPositiveInt(30),
  /**
   * D18: give the chat box the knowledge tools (`search_knowledge`, `get_document`,
   * `list_documents`), so it answers from the workspace's own material. It costs more tokens per
   * turn and, on Workers AI — which has no tool-call event stream — the reply stops arriving token
   * by token. `false` is the operator's way back to a tool-free chat.
   */
  CHAT_KNOWLEDGE_TOOLS: optionalBoolean(true),
  /**
   * D17: characters of stored history a chat turn may replay. The real constraint is the model's
   * context window and the tenant picks the model, so this is the knob rather than a message count
   * — 24 000 chars is roughly 6 000 tokens, which leaves room on the 24k-token Workers AI floor.
   * Raise it for a long-context provider. Anything older is trimmed and folded into the thread's
   * rolling summary by the `chat.compact` job.
   */
  CHAT_HISTORY_MAX_CHARS: optionalPositiveInt(24_000),
  /**
   * D30, layer 1: the feature keys this deployment ships AT ALL. Only consulted for a flag whose
   * registry entry sets `environmentGated` — everything else is decided by the rollout state in the
   * database, so an ordinary flag needs no toml edit.
   *
   * Blank means none, which is the FAIL-CLOSED direction and the point: this gate's failure mode is
   * an unreleased surface appearing in production, so an environment that forgets the var stays
   * dark. Note `wrangler dev` reads `[vars]` from `wrangler.toml`, so a key listed only in staging
   * is absent on every developer's laptop unless `.dev.vars` overrides it — which is why
   * `.dev.vars.example` lists the kit's gated keys.
   */
  FEATURES_ENABLED: csvKeys,

  // ---- Secrets (.dev.vars locally, `wrangler secret put` deployed) — all optional here;
  //      features gate on presence (zero-creds first run) or demand them at use time. -------
  /** Dev/fallback owner connection string; deployed Workers use the HYPERDRIVE binding. */
  DATABASE_URL: optionalString,
  /** Per-PR Neon branch; when set it wins over HYPERDRIVE (see db/client.ts). */
  PREVIEW_DATABASE_URL: optionalString,
  /** AES-GCM key for OAuth tokens at rest (D12). */
  OAUTH_ENCRYPTION_KEY: optionalSecret(32),
  RESEND_API_KEY: optionalString,
  /** Comma-separated emails promoted to global admin on first VERIFIED login (D9). */
  BOOTSTRAP_ADMIN_EMAILS: csvList,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  MICROSOFT_CLIENT_ID: optionalString,
  MICROSOFT_CLIENT_SECRET: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  EMBEDDINGS_API_KEY: optionalString,
  LANGFUSE_PUBLIC_KEY: optionalString,
  LANGFUSE_SECRET_KEY: optionalString,
})

export type AppConfig = z.infer<typeof configSchema>
export type AppEnvName = AppConfig['APP_ENV']
export type OAuthProviderName = 'google' | 'microsoft'

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

/** `{APP_URL}/auth/{provider}/callback` — never configured per provider (D11). */
export function oauthRedirectUri(cfg: AppConfig, provider: OAuthProviderName): string {
  return new URL(`/auth/${provider}/callback`, cfg.APP_URL).toString()
}

/** Without a Resend key, magic links are logged instead of sent (zero-creds first run). */
export const hasEmail = (cfg: AppConfig): boolean => Boolean(cfg.RESEND_API_KEY)

/** Providers whose client id AND secret are both present — the login page shows only these. */
export function configuredOAuthProviders(cfg: AppConfig): OAuthProviderName[] {
  const providers: OAuthProviderName[] = []
  if (cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET) providers.push('google')
  if (cfg.MICROSOFT_CLIENT_ID && cfg.MICROSOFT_CLIENT_SECRET) providers.push('microsoft')
  return providers
}
