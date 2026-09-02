/**
 * `Cloudflare.Env`-shaped test bindings (D15): in-memory KV, a 404 ASSETS fetcher, HYPERDRIVE
 * pointing at the test Postgres, a recording Queue, an in-memory R2 bucket, a recording DO namespace,
 * a recording Workers AI stub, a recording Workflow namespace, and vars from `process.env` (loaded
 * from .env.test by dotenv-cli). The AI stub also answers `toMarkdown` (D18 uploads). Tests may
 * read `process.env`; `src/` may not.
 *
 * Also `createExecutionContext()` — `waitUntil` collects promises so `waitOnExecutionContext`
 * can drain them; this is how the per-request DB close (middleware/database.ts) is awaited.
 */
import { deterministicEmbedding } from '@/api/services/ai/deterministic-embedding'
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

// ---- R2 -----------------------------------------------------------------------------------

interface R2Entry {
  body: Uint8Array
  httpMetadata?: R2HTTPMetadata
  customMetadata?: Record<string, string>
  uploaded: Date
}

/** Enough of R2Bucket for `services/storage.ts` (Phase 2): put/get/head/delete/list. */
export class MemoryR2Bucket {
  readonly objects = new Map<string, R2Entry>()

  private toObject(key: string, e: R2Entry): R2Object {
    return {
      key,
      size: e.body.byteLength,
      etag: `"${e.body.byteLength}-${e.uploaded.getTime()}"`,
      httpEtag: `"${e.body.byteLength}-${e.uploaded.getTime()}"`,
      uploaded: e.uploaded,
      httpMetadata: e.httpMetadata ?? {},
      customMetadata: e.customMetadata ?? {},
      version: '1',
      checksums: {} as R2Checksums,
      storageClass: 'Standard',
      writeHttpMetadata: (headers: Headers) => {
        if (e.httpMetadata?.contentType) headers.set('content-type', e.httpMetadata.contentType)
      },
    } as unknown as R2Object
  }

  async put(
    key: string,
    value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
    options?: { httpMetadata?: R2HTTPMetadata | Headers; customMetadata?: Record<string, string> }
  ): Promise<R2Object> {
    const body =
      value === null
        ? new Uint8Array()
        : typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : ArrayBuffer.isView(value)
              ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
              : new Uint8Array(await new Response(value as ReadableStream | Blob).arrayBuffer())
    const httpMetadata =
      options?.httpMetadata instanceof Headers
        ? { contentType: options.httpMetadata.get('content-type') ?? undefined }
        : options?.httpMetadata
    const entry: R2Entry = {
      body,
      httpMetadata,
      customMetadata: options?.customMetadata,
      uploaded: new Date(),
    }
    this.objects.set(key, entry)
    return this.toObject(key, entry)
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const e = this.objects.get(key)
    if (!e) return null
    const obj = this.toObject(key, e) as unknown as Record<string, unknown>
    const bytes = e.body
    return {
      ...obj,
      body: new Response(bytes as unknown as BodyInit).body,
      bodyUsed: false,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      blob: async () => new Blob([bytes as unknown as BlobPart]),
      bytes: async () => bytes,
    } as unknown as R2ObjectBody
  }

  async head(key: string): Promise<R2Object | null> {
    const e = this.objects.get(key)
    return e ? this.toObject(key, e) : null
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k)
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<R2Objects> {
    const prefix = options?.prefix ?? ''
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, options?.limit ?? 1000)
      .map(([k, e]) => this.toObject(k, e))
    return { objects, truncated: false, delimitedPrefixes: [] } as unknown as R2Objects
  }
}

// ---- Durable Object namespace ---------------------------------------------------------------

export interface RecordedBroadcast {
  tenantId: string
  args: unknown[]
}

/**
 * Stub `NOTIFICATIONS_HUB` namespace (Phase 2, D8). `idFromName(tenantId).get()` returns a stub whose
 * RPC methods (`broadcast`, `broadcastToUser`, …) record their calls in `broadcasts` so route tests
 * can assert "a nudge was sent to tenant X" without a real Durable Object. `fetch` answers 501.
 */
export class RecordingDurableObjectNamespace {
  readonly broadcasts: RecordedBroadcast[] = []
  idFromName(name: string) {
    return { toString: () => name, name, equals: (o: { name?: string }) => o.name === name }
  }
  newUniqueId() {
    return this.idFromName(crypto.randomUUID())
  }
  idFromString(id: string) {
    return this.idFromName(id)
  }
  get(id: { name: string }) {
    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        this.broadcasts.push({ tenantId: id.name, args: [method, ...args] })
        return { delivered: 0 }
      }
    return new Proxy(
      {
        id,
        name: id.name,
        fetch: async () => new Response('DO stub', { status: 501 }),
      } as Record<string, unknown>,
      { get: (t, prop: string) => (prop in t ? t[prop] : record(prop)) }
    )
  }
  clear(): void {
    this.broadcasts.length = 0
  }
}

// ---- Workers AI ------------------------------------------------------------------------------

export interface RecordedAiRun {
  model: string
  inputs: Record<string, unknown>
}

export interface RecordedConversion {
  name: string
  type: string
  size: number
}

/** The platform's `ConversionResponse` shape (see `services/ai/types.ts` `MarkdownConversion`). */
export type FakeConversion =
  | {
      id: string
      name: string
      mimeType: string
      format: 'markdown' | 'text'
      tokens: number
      data: string
    }
  | { id: string; name: string; mimeType: string; format: 'error'; error: string }

/**
 * Stub `AI` binding (Phase 3, D17): `run()` records the call and answers an embeddings-shaped
 * `{ shape, data }` of deterministic 1024-dim vectors (one per input text) so `resolveEmbeddings`'s
 * `workers_ai` branch is testable without the platform. Override `respond` to shape other models.
 * `toMarkdown()` (D18 uploads) records `{ name, type, size }` in `conversions` and answers markdown
 * made of the blob's bytes decoded as text — so a fixture "PDF" is just text typed
 * `application/pdf`; override `convert` for `format: 'error'` or a thrown outage.
 */
export class RecordingAi {
  readonly runs: RecordedAiRun[] = []
  readonly conversions: RecordedConversion[] = []
  convert: (doc: { name: string; blob: Blob }) => Promise<FakeConversion> = async doc => ({
    id: crypto.randomUUID(),
    name: doc.name,
    mimeType: doc.blob.type,
    format: 'markdown',
    tokens: Math.ceil(doc.blob.size / 4),
    data: `# ${doc.name}\n\n${await doc.blob.text()}`,
  })
  async toMarkdown(doc: { name: string; blob: Blob }): Promise<FakeConversion> {
    this.conversions.push({ name: doc.name, type: doc.blob.type, size: doc.blob.size })
    return this.convert(doc)
  }
  /**
   * Default answers: a chat call (`inputs.messages`) gets `{ response: 'ok', usage }` in the
   * non-streamed shape — override `respond` with an SSE `ReadableStream` to exercise streaming —
   * and an embeddings call (`inputs.text`) gets deterministic 1024-dim vectors.
   */
  respond: (model: string, inputs: Record<string, unknown>) => unknown = (_model, inputs) => {
    if (Array.isArray(inputs.messages)) {
      return { response: 'ok', usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }
    }
    const text = inputs.text
    const texts = Array.isArray(text) ? text : [String(text ?? '')]
    return {
      shape: [texts.length, 1024],
      data: texts.map(t => deterministicEmbedding(String(t))),
    }
  }
  async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    this.runs.push({ model, inputs })
    return this.respond(model, inputs)
  }
  clear(): void {
    this.runs.length = 0
    this.conversions.length = 0
  }
}

// ---- Workflow --------------------------------------------------------------------------------

export interface RecordedWorkflowInstance {
  id: string
  params: unknown
}

/** What `instance.status()` answers — the shape of the platform's `InstanceStatus`. */
export interface FakeInstanceStatus {
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'errored'
    | 'terminated'
    | 'complete'
    | 'waiting'
    | 'waitingForPause'
    | 'unknown'
  error?: { name: string; message: string }
  output?: unknown
}

/**
 * Stub `AGENT_RUN_WORKFLOW` binding (Phase 3b, D7): `create()` records `{ id, params }` and
 * answers an instance whose `status()` is whatever `setStatus(id, …)` said (default `running`);
 * a second `create` with the same id throws like the platform; `get()` throws `instance.not_found`
 * for an id never created unless a status was pre-seeded for it. Nothing runs — tests drive the
 * `AgentRunWorkflow` class directly with a fake step.
 */
export class RecordingWorkflow {
  readonly created: RecordedWorkflowInstance[] = []
  readonly statuses = new Map<string, FakeInstanceStatus>()
  /** Instance ids a forced cancel terminated, in order. */
  readonly terminated: string[] = []
  defaultStatus: FakeInstanceStatus = { status: 'running' }

  async create(options: { id?: string; params?: unknown } = {}) {
    const id = options.id ?? crypto.randomUUID()
    if (this.created.some(c => c.id === id)) {
      throw new Error(`instance.already_exists: an instance with id ${id} already exists`)
    }
    this.created.push({ id, params: options.params })
    return this.instance(id)
  }

  async get(id: string) {
    if (!this.created.some(c => c.id === id) && !this.statuses.has(id)) {
      throw new Error(`instance.not_found: no instance with id ${id}`)
    }
    return this.instance(id)
  }

  /** Make `status()` for `id` answer this (also makes `get(id)` resolve). */
  setStatus(id: string, status: FakeInstanceStatus): void {
    this.statuses.set(id, status)
  }

  private instance(id: string) {
    return {
      id,
      status: async (): Promise<FakeInstanceStatus> => this.statuses.get(id) ?? this.defaultStatus,
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {
        this.terminated.push(id)
        this.statuses.set(id, { status: 'terminated' })
      },
      restart: async () => {},
      sendEvent: async () => {},
    }
  }

  clear(): void {
    this.created.length = 0
    this.terminated.length = 0
    this.statuses.clear()
  }
}

// ---- Env -----------------------------------------------------------------------------------

/**
 * Structurally `Cloudflare.Env` so it can be passed straight to `app.request`, `queue()` and
 * `scheduled()`. The bindings are in-memory stubs cast to the platform types; reach the stubs'
 * inspection surface (recorded messages, stored objects, KV store) through `stubs(env)`.
 */
export type TestEnv = AppBindings & {
  DATABASE_URL: string
  [secret: string]: unknown
}

const SECRET_KEYS = [
  'DATABASE_URL',
  'PREVIEW_DATABASE_URL',
  'OAUTH_ENCRYPTION_KEY',
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
  'LANGFUSE_TRACING_ENVIRONMENT',
  'AGENT_MAX_OUTPUT_TOKENS',
  'AGENT_MAX_TURNS',
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
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5433/rocketflare_test'
  const env: Record<string, unknown> = {
    RATE_LIMIT_KV: new MemoryKV() as unknown as KVNamespace,
    HYPERDRIVE: hyperdriveStub(databaseUrl),
    ASSETS: assetsStub(),
    JOBS_QUEUE: new RecordingQueue() as unknown as Queue,
    FILES: new MemoryR2Bucket() as unknown as R2Bucket,
    NOTIFICATIONS_HUB: new RecordingDurableObjectNamespace() as unknown as DurableObjectNamespace,
    AI: new RecordingAi() as unknown as Ai,
    AGENT_RUN_WORKFLOW: new RecordingWorkflow() as unknown as Workflow,
    APP_ENV: process.env.APP_ENV ?? 'development',
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    APP_NAME: process.env.APP_NAME ?? 'Rocketflare Test',
    RELEASE_VERSION: process.env.RELEASE_VERSION ?? 'test',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
    EMAIL_FROM: process.env.EMAIL_FROM ?? 'Rocketflare Test <noreply@example.com>',
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

/** Typed access to the in-memory stubs behind a `createTestEnv()` env. */
export function stubs(env: TestEnv) {
  return {
    kv: env.RATE_LIMIT_KV as unknown as MemoryKV,
    queue: env.JOBS_QUEUE as unknown as RecordingQueue,
    files: env.FILES as unknown as MemoryR2Bucket,
    hub: env.NOTIFICATIONS_HUB as unknown as RecordingDurableObjectNamespace,
    ai: env.AI as unknown as RecordingAi | undefined,
    workflow: env.AGENT_RUN_WORKFLOW as unknown as RecordingWorkflow | undefined,
  }
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
