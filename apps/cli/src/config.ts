/**
 * CLI config (D26): `~/.rocketflare/config.json` (dir 0700, file 0600) holding the server URL, API key,
 * active tenant and the signed-in user. Env overrides for CI: `ROCKETFLARE_API_KEY`, `ROCKETFLARE_URL`, and
 * `ROCKETFLARE_CONFIG_DIR` to relocate the directory. ADAPTING renames the `ROCKETFLARE_` prefix and `.rocketflare` dir
 * here — these constants are the only place they live.
 */
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const ENV_PREFIX = 'ROCKETFLARE'
export const CONFIG_DIR_NAME = '.rocketflare'
export const CONFIG_FILE_NAME = 'config.json'
/** The kit's local `wrangler dev` port; a real app sets its production URL here. */
export const DEFAULT_SERVER_URL = 'http://localhost:3001'

export const ENV = {
  apiKey: `${ENV_PREFIX}_API_KEY`,
  url: `${ENV_PREFIX}_URL`,
  configDir: `${ENV_PREFIX}_CONFIG_DIR`,
  debug: `${ENV_PREFIX}_DEBUG`,
} as const

export const cliConfigSchema = z.object({
  serverUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  tenantId: z.string().optional(),
  tenantName: z.string().optional(),
  user: z.object({ email: z.string().optional(), name: z.string().optional() }).optional(),
})
export type CliConfig = z.infer<typeof cliConfigSchema>

/** Keys `config get|set` may touch. `apiKey` is settable but always printed redacted. */
export const CONFIG_KEYS = ['serverUrl', 'apiKey', 'tenantId', 'tenantName'] as const
export type ConfigKey = (typeof CONFIG_KEYS)[number]

export type Env = Record<string, string | undefined>

export function resolveConfigDir(env: Env = process.env): string {
  return env[ENV.configDir] ?? join(env.HOME ?? homedir(), CONFIG_DIR_NAME)
}

export interface ResolvedConfig {
  serverUrl: string
  serverUrlSource: 'flag' | 'env' | 'config' | 'default'
  apiKey?: string
  apiKeySource: 'env' | 'config' | 'none'
  tenantId?: string
  tenantName?: string
  user?: CliConfig['user']
}

export interface ConfigStore {
  readonly dir: string
  readonly file: string
  load(): Promise<CliConfig>
  save(config: CliConfig): Promise<void>
  update(patch: Partial<CliConfig>): Promise<CliConfig>
  /** Remove credentials and tenant, keep `serverUrl`. */
  clearCredentials(): Promise<void>
  /** Delete the file entirely. */
  clear(): Promise<void>
  /** Merge file + env + an optional `--server` flag into what a command should use. */
  resolve(overrides?: { serverUrl?: string }): Promise<ResolvedConfig>
}

export function createConfigStore(options: { dir?: string; env?: Env } = {}): ConfigStore {
  const env = options.env ?? process.env
  const dir = options.dir ?? resolveConfigDir(env)
  const file = join(dir, CONFIG_FILE_NAME)

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
  }

  async function load(): Promise<CliConfig> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const parsed = cliConfigSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error(`Config file ${file} is invalid: ${parsed.error.issues[0]?.message}`)
    }
    return parsed.data
  }

  async function save(config: CliConfig): Promise<void> {
    await ensureDir()
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    // `mode` only applies on creation; tighten an existing file too.
    await chmod(file, 0o600)
  }

  return {
    dir,
    file,
    load,
    save,
    async update(patch) {
      const next = { ...(await load()), ...patch }
      await save(next)
      return next
    },
    async clearCredentials() {
      const { serverUrl } = await load()
      await save(serverUrl ? { serverUrl } : {})
    },
    async clear() {
      await rm(file, { force: true })
    },
    async resolve(overrides = {}) {
      const config = await load()
      const envUrl = env[ENV.url]
      const envKey = env[ENV.apiKey]
      const [serverUrl, serverUrlSource]: [string, ResolvedConfig['serverUrlSource']] =
        overrides.serverUrl !== undefined
          ? [overrides.serverUrl, 'flag']
          : envUrl
            ? [envUrl, 'env']
            : config.serverUrl
              ? [config.serverUrl, 'config']
              : [DEFAULT_SERVER_URL, 'default']
      const [apiKey, apiKeySource]: [string | undefined, ResolvedConfig['apiKeySource']] = envKey
        ? [envKey, 'env']
        : config.apiKey
          ? [config.apiKey, 'config']
          : [undefined, 'none']
      return {
        serverUrl: serverUrl.replace(/\/+$/, ''),
        serverUrlSource,
        apiKey,
        apiKeySource,
        tenantId: config.tenantId,
        tenantName: config.tenantName,
        user: config.user,
      }
    },
  }
}

/** File mode bits (e.g. `0o600`) or null when the path does not exist. */
export async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return null
  }
}

/** Characters shown of a key: `rocketflare_` (12) + 4 — never the full secret. `rocketflare_ab12…` */
export const REDACTED_KEY_CHARS = 16

/** Show only the key prefix — never the full secret. `rocketflare_ab12…` */
export function redactKey(key: string | undefined): string {
  if (!key) return '-'
  return key.length <= REDACTED_KEY_CHARS ? '****' : `${key.slice(0, REDACTED_KEY_CHARS)}…`
}

/** A copy of the config safe to print: the key is redacted. */
export function redactConfig(config: CliConfig): CliConfig {
  return config.apiKey ? { ...config, apiKey: redactKey(config.apiKey) } : config
}
