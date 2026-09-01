/**
 * `Cloudflare.Env`-shaped test bindings (D15): in-memory KV, a 404 ASSETS fetcher, HYPERDRIVE
 * pointing at the test Postgres, a recording Queue, and vars from `process.env` (loaded from
 * .env.test by dotenv-cli). Tests may read `process.env`; `src/` may not.
 *
 * Also `createExecutionContext()` — `waitUntil` collects promises so `waitOnExecutionContext`
 * can drain them; this is how the per-request DB close (middleware/database.ts) is awaited.
 */
import type { AppBindings } from '@/api/types'

// ---- KV -----------------------------------------------------------------------------------

interface KvEntry {
  value: string
  expiresAt?: number
  metadata?: unknown
}

/** Enough of KVNamespace for rate limiting and operation locks. */
export class MemoryKV {
  readonly store = new Map<string, KvEntry>()

  private live(key: string): KvEntry | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry
  }

  async get(key: string, type?: string | { type?: string }): Promise<unknown> {
    const entry = this.live(key)
    if (!entry) return null
    const t = typeof type === 'string' ? type : type?.type
    if (t === 'json') return JSON.parse(entry.value)
    if (t === 'arrayBuffer') return new TextEncoder().encode(entry.value).buffer
    return entry.value
  }

  async getWithMetadata(key: string, type?: string) {
    const entry = this.live(key)
    return {
      value: entry ? await this.get(key, type) : null,
      metadata: entry?.metadata ?? null,
      cacheStatus: null,
    }
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
  ): Promise<void> {
    const text =
      typeof value === 'string'
        ? value
        : value instanceof ArrayBuffer
          ? new TextDecoder().decode(value)
          : ArrayBuffer.isView(value)
            ? new TextDecoder().decode(value)
            : await new Response(value).text()
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration
        ? options.expiration * 1000
        : undefined
    this.store.set(key, { value: text, expiresAt, metadata: options?.metadata })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const keys = [...this.store.keys()]
      .filter(k => k.startsWith(prefix) && this.live(k))
      .sort()
      .slice(0, options?.limit ?? 1000)
      .map(name => ({
        name,
        expiration: this.store.get(name)?.expiresAt,
        metadata: this.store.get(name)?.metadata,
      }))
    return { keys, list_complete: true as const, cacheStatus: null }
  }
}

// ---- Queue ---------------------------------------------------------------------------------

export interface RecordedMessage<T = unknown> {
  body: T
  options?: unknown
}

/** Records `send`/`sendBatch` calls so tests can assert what routes enqueued (Phase 2). */
export class RecordingQueue<T = unknown> {
  readonly messages: RecordedMessage<T>[] = []
  async send(body: T, options?: unknown): Promise<void> {
    this.messages.push({ body, options })
  }
  async sendBatch(messages: Iterable<{ body: T; options?: unknown }>): Promise<void> {
    for (const m of messages) this.messages.push({ body: m.body, options: m.options })
  }
  clear(): void {
    this.messages.length = 0
  }
}

// ---- Env -----------------------------------------------------------------------------------

export type TestEnv = AppBindings & {
  /** Present now so Phase 2 code can bind it; not in Cloudflare.Env until wrangler.toml adds it. */
  JOBS_QUEUE: RecordingQueue
  DATABASE_URL: string
  [secret: string]: unknown
}

const SECRET_KEYS = [
  'DATABASE_URL',
  'PREVIEW_DATABASE_URL',
  'OAUTH_ENCRYPTION_KEY',
  'AUTH_SIGNING_KEY',
  'RESEND_API_KEY',
  'BOOTSTRAP_ADMIN_EMAILS',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'ANTHROPIC_API_KEY',
  'EMBEDDINGS_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL',
] as const

function assetsStub(): Fetcher {
  return {
    fetch: async () => new Response('Not Found (ASSETS stub)', { status: 404 }),
    connect: () => {
      throw new Error('ASSETS.connect is not supported in tests')
    },
  } as unknown as Fetcher
}

function hyperdriveStub(connectionString: string): Hyperdrive {
  const url = new URL(connectionString)
  return {
    connectionString,
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connect: () => {
      throw new Error('HYPERDRIVE.connect is not supported in tests')
    },
  } as unknown as Hyperdrive
}

/**
 * A fresh env per call (KV and queue state are not shared between calls). Vars come from
 * process.env with .env.test-compatible defaults; pass `overrides` to change any of them.
 */
export function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/gmgo_test'
  const env: Record<string, unknown> = {
    RATE_LIMIT_KV: new MemoryKV() as unknown as KVNamespace,
    HYPERDRIVE: hyperdriveStub(databaseUrl),
    ASSETS: assetsStub(),
    JOBS_QUEUE: new RecordingQueue(),
    APP_ENV: process.env.APP_ENV ?? 'development',
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    APP_NAME: process.env.APP_NAME ?? 'GMGO Test',
    RELEASE_VERSION: process.env.RELEASE_VERSION ?? 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'GMGO Test <noreply@example.com>',
    TENANCY_MODE: process.env.TENANCY_MODE ?? 'multi',
    SIGNUP_MODE: process.env.SIGNUP_MODE ?? 'invite_only',
    TENANT_SCOPE_MODE: process.env.TENANT_SCOPE_MODE ?? 'off',
  }
  for (const key of SECRET_KEYS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  env.DATABASE_URL = databaseUrl
  return { ...env, ...overrides } as TestEnv
}

// ---- ExecutionContext ----------------------------------------------------------------------

export interface TestExecutionContext extends ExecutionContext {
  readonly pending: Promise<unknown>[]
}

export function createExecutionContext(): TestExecutionContext {
  const pending: Promise<unknown>[] = []
  return {
    pending,
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise)
    },
    passThroughOnException() {},
    props: {},
    exports: {} as Cloudflare.Exports,
    tracing: {} as never,
    abort() {},
  } as TestExecutionContext
}

/** Await everything passed to `waitUntil`, including promises enqueued while draining. */
export async function waitOnExecutionContext(ctx: TestExecutionContext): Promise<void> {
  let settled = 0
  while (settled < ctx.pending.length) {
    const batch = ctx.pending.slice(settled)
    settled = ctx.pending.length
    await Promise.allSettled(batch)
  }
}
