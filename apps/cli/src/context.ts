/**
 * Per-invocation command context (D26): resolved config, logger (stderr), output (stdout) and the
 * injectable `fetch`/`open` seams tests use. Commands receive a context and return; they never
 * touch `process` directly.
 */
import { type ApiClient, createApiClient, type FetchLike } from './api'
import { type ConfigStore, createConfigStore, ENV, type Env, type ResolvedConfig } from './config'
import { NotLoggedInError } from './errors'
import { BIN_NAME } from './package-info'
import { createLogger, type Logger } from './utils/logger'
import { createOutput, type Output } from './utils/output'

export type OpenLike = (url: string) => Promise<unknown>

export interface CommandContext {
  store: ConfigStore
  /** Config merged with env and `--server` — what the command should use. */
  config: ResolvedConfig
  json: boolean
  log: Logger
  out: Output
  fetch: FetchLike
  open: OpenLike
  binName: string
}

export interface ContextOptions {
  /** `--server <url>` */
  server?: string
  json?: boolean
  store?: ConfigStore
  env?: Env
  log?: Logger
  out?: Output
  fetch?: FetchLike
  open?: OpenLike
}

export async function createContext(options: ContextOptions = {}): Promise<CommandContext> {
  const env = options.env ?? process.env
  const store = options.store ?? createConfigStore({ env })
  const json = options.json ?? false
  return {
    store,
    config: await store.resolve({ serverUrl: options.server }),
    json,
    log: options.log ?? createLogger({ debug: Boolean(env[ENV.debug]) }),
    out: options.out ?? createOutput({ json }),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    open: options.open ?? (async url => (await import('open')).default(url)),
    binName: BIN_NAME,
  }
}

/** An authenticated client, or `NotLoggedInError` (exit 2) when no key is configured. */
export function requireClient(ctx: CommandContext): ApiClient {
  if (!ctx.config.apiKey) throw new NotLoggedInError(ctx.binName)
  return createApiClient({
    serverUrl: ctx.config.serverUrl,
    apiKey: ctx.config.apiKey,
    fetch: ctx.fetch,
  })
}

/** An unauthenticated client (health checks). */
export function publicClient(ctx: CommandContext): ApiClient {
  return createApiClient({ serverUrl: ctx.config.serverUrl, fetch: ctx.fetch })
}
