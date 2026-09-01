/** `gmgo config get [key] | set <key> <value> | path` — the API key is only ever printed redacted (D26). */
import { CONFIG_KEYS, type ConfigKey, redactConfig, redactKey } from '../config'
import type { CommandContext } from '../context'
import { CliError } from '../errors'
import { formatJson } from '../utils/output'

function assertKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) return key as ConfigKey
  throw new CliError(`Unknown config key "${key}"`, {
    hint: `Valid keys: ${CONFIG_KEYS.join(', ')}`,
  })
}

export async function runConfigGet(ctx: CommandContext, key?: string): Promise<void> {
  const config = redactConfig(await ctx.store.load())
  if (key === undefined) {
    ctx.out.data(config, () => formatJson(config))
    return
  }
  const value = config[assertKey(key)]
  ctx.out.data({ [key]: value ?? null }, () => (value === undefined ? '' : String(value)))
}

export async function runConfigSet(ctx: CommandContext, key: string, value: string): Promise<void> {
  const name = assertKey(key)
  if (name === 'serverUrl') {
    try {
      new URL(value)
    } catch {
      throw new CliError(`"${value}" is not a valid URL`)
    }
  }
  const stored = name === 'serverUrl' ? value.replace(/\/+$/, '') : value
  await ctx.store.update({ [name]: stored })
  ctx.log.success(`${name} = ${name === 'apiKey' ? redactKey(stored) : stored}`)
}

export async function runConfigPath(ctx: CommandContext): Promise<void> {
  ctx.out.data({ path: ctx.store.file, dir: ctx.store.dir }, () => ctx.store.file)
}
