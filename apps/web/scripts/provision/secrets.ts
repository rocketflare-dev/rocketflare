/**
 * Worker secrets through wrangler. `wrangler secret put NAME` reads the value from STDIN when
 * stdin is not a TTY (wrangler source, packages/wrangler/src/secret/index.ts:
 * `isInteractive ? await prompt(...) : await readFromStdin()`), so a value never appears in an
 * argument list or a shell history. `wrangler secret list` prints JSON by default
 * (`--format json`, verified with `wrangler secret list --help`, wrangler 4.127).
 * `wrangler secret bulk` is deliberately NOT used.
 */
import { randomBytes } from 'node:crypto'
import { type EnvName, ProvisionError, wrangler, wranglerConfigArgs } from './config'

export const OAUTH_KEY_HEX_LENGTH = 64

/** 32 random bytes as 64 hex — the shape `optionalSecret(32)` in src/config.ts validates. */
export const generateHexKey = (): string => randomBytes(OAUTH_KEY_HEX_LENGTH / 2).toString('hex')

export async function listWorkerSecrets(env: EnvName): Promise<string[]> {
  const r = await wrangler(['secret', 'list', '--format', 'json', ...wranglerConfigArgs(env)], {
    echo: false,
    allowFailure: true,
  })
  if (r.status !== 0) {
    // A Worker that has never been deployed has no secrets to list; wrangler reports an error.
    if (/not found|does not exist|10007/i.test(r.stderr + r.stdout)) return []
    throw new ProvisionError(`wrangler secret list failed: ${(r.stderr || r.stdout).trim()}`)
  }
  const start = r.stdout.indexOf('[')
  if (start < 0) return []
  try {
    const arr = JSON.parse(r.stdout.slice(start)) as { name: string }[]
    return arr.map(s => s.name)
  } catch {
    return []
  }
}

export async function putWorkerSecret(env: EnvName, name: string, value: string): Promise<void> {
  if (!value) throw new ProvisionError(`refusing to set empty secret ${name}`)
  await wrangler(['secret', 'put', name, ...wranglerConfigArgs(env)], { stdin: value, echo: false })
}
