/**
 * `pnpm provision tokens` — the one interactive way in for the four vendor tokens. Needs a real
 * terminal (`process.stdin.isTTY`): a coding agent's shell has none, which is the point — a token
 * is typed by the person, hidden (`readline` over a muted output, like `read -s`), verified against
 * the vendor at once, and written to `apps/web/.provision.env` (mode 0600). Nothing typed here is
 * ever printed; `Verify:` names the tokens, never their values.
 *
 * Checks: Cloudflare — `wrangler whoami` with the candidate token in the child environment (a bad
 * token exits 1: `/user/tokens/verify` fails), then the account id must appear in that output or
 * answer `GET /accounts/{id}`; Neon — `GET /users/me`; Resend — `GET /domains`.
 */
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { CloudflareClient } from './cloudflare-dns'
import {
  log,
  ProvisionError,
  REQUIRED_TOKENS,
  reloadTokenFile,
  TOKEN_FILE,
  TOKEN_FILE_EXAMPLE,
  TOKEN_FILE_LABEL,
  TOKEN_HELP,
  tokenSource,
  verifyLine,
  warn,
  wrangler,
} from './config'
import { maskToken, REDACT_EXEMPT_KEYS, upsertEnvFile } from './env-file'
import { NeonClient } from './neon'
import { redact, registerSecrets } from './redact'
import { ResendClient } from './resend'

export const MAX_TRIES = 3

export function requireTty(): void {
  if (!process.stdin.isTTY)
    throw new ProvisionError(
      `pnpm provision tokens needs a terminal — run this in your own terminal, it prompts (hidden input) and writes ${TOKEN_FILE_LABEL}. Without a terminal, copy ${TOKEN_FILE_LABEL}.example to ${TOKEN_FILE_LABEL} and fill it in, or export the variables.`,
      2
    )
}

/** `read -s`: the prompt goes to stdout, the echo goes nowhere. Ctrl-C exits 130. */
export async function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true })
  try {
    const interrupted = new Promise<never>((_, reject) => {
      rl.once('SIGINT', () => reject(new ProvisionError('interrupted', 130)))
    })
    const answer = await Promise.race([rl.question(''), interrupted])
    return answer.trim()
  } finally {
    rl.close()
    process.stdout.write('\n')
  }
}

type Check = (value: string) => Promise<string>

interface Outcome {
  name: string
  action: 'set' | 'kept' | 'unverified' | 'skipped'
  source?: 'env' | 'file'
  detail?: string
}

/**
 * Ask for one token: Enter keeps what exists (from the file, or from the environment — which
 * would shadow the file anyway), a typed value is checked up to `MAX_TRIES` times and, when the
 * vendor never agrees, stored unverified with a warning (an outage must not lose the work).
 */
async function askToken(
  name: string,
  check: Check,
  updates: Record<string, string>
): Promise<Outcome> {
  const help = TOKEN_HELP[name]
  const existing = tokenSource(name)
  console.log(`\n${name}`)
  console.log(`  mint:  ${help.url}`)
  console.log(`  scope: ${help.scopes}`)
  console.log(
    `  now:   ${existing ? `${maskToken(existing.value)} (from ${existing.source === 'env' ? 'the environment — it overrides the file' : TOKEN_FILE_LABEL})` : 'not set'}`
  )
  let last: string | undefined
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const typed = await promptHidden(
      `  paste ${name}${existing ? ' (Enter keeps the current value)' : ''}: `
    )
    if (!typed) {
      if (existing) return { name, action: 'kept', source: existing.source }
      console.log('  nothing entered')
      continue
    }
    if (!REDACT_EXEMPT_KEYS.has(name)) registerSecrets([typed])
    last = typed
    try {
      const detail = await check(typed)
      updates[name] = typed
      return { name, action: 'set', detail }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(redact(`  not accepted (${attempt}/${MAX_TRIES}): ${msg.split('\n')[0]}`))
    }
  }
  if (last) {
    updates[name] = last
    warn(`${name} could not be verified after ${MAX_TRIES} tries — saved unverified`)
    return { name, action: 'unverified' }
  }
  return { name, action: 'skipped' }
}

/** The account id must be visible to the token: in `wrangler whoami`'s table, or via `GET /accounts/{id}`. */
async function checkAccountId(id: string, apiToken: string, whoami: string): Promise<string> {
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new ProvisionError('an account id is 32 hex characters')
  const line = whoami.split('\n').find(l => l.includes(id))
  if (line) {
    const name = line
      .split('│')
      .map(s => s.trim())
      .filter(Boolean)[0]
    return `account ${name ?? id}`
  }
  const account = await new CloudflareClient(apiToken).request<{ name?: string }>(
    'GET',
    `/accounts/${id}`
  )
  return `account ${account?.name ?? id}`
}

export async function tokensPhase(flags: { skipEmail: boolean; debug: boolean }): Promise<void> {
  requireTty()
  console.log(
    `\n== tokens\nStored in ${TOKEN_FILE_LABEL} (git-ignored, mode 0600). Input is hidden; nothing you type is printed.`
  )

  const updates: Record<string, string> = {}
  const outcomes: Outcome[] = []
  let whoamiOut = ''
  let cfToken: string | undefined

  const cf = await askToken(
    'CLOUDFLARE_API_TOKEN',
    async value => {
      const r = await wrangler(['whoami'], {
        echo: false,
        allowFailure: true,
        env: { CLOUDFLARE_API_TOKEN: value, CLOUDFLARE_ACCOUNT_ID: undefined },
      })
      if (r.status !== 0) throw new ProvisionError('wrangler whoami rejected the token')
      whoamiOut = r.stdout
      const accounts = (r.stdout.match(/[0-9a-f]{32}/gi) ?? []).length
      return `wrangler whoami ok (${accounts} account${accounts === 1 ? '' : 's'} visible)`
    },
    updates
  )
  outcomes.push(cf)
  cfToken = updates.CLOUDFLARE_API_TOKEN ?? tokenSource('CLOUDFLARE_API_TOKEN')?.value
  if (cf.action === 'kept' && cfToken) {
    const r = await wrangler(['whoami'], {
      echo: false,
      allowFailure: true,
      env: { CLOUDFLARE_API_TOKEN: cfToken },
    })
    whoamiOut = r.stdout
  }

  outcomes.push(
    await askToken(
      'CLOUDFLARE_ACCOUNT_ID',
      async value => {
        if (!cfToken) throw new ProvisionError('set CLOUDFLARE_API_TOKEN first')
        return checkAccountId(value, cfToken, whoamiOut)
      },
      updates
    )
  )

  outcomes.push(
    await askToken(
      'NEON_API_KEY',
      async value => {
        const me = await new NeonClient(value, fetch, flags.debug).me()
        return `neon ${me.email}`
      },
      updates
    )
  )

  if (flags.skipEmail) outcomes.push({ name: 'RESEND_API_KEY', action: 'skipped' })
  else
    outcomes.push(
      await askToken(
        'RESEND_API_KEY',
        async value => {
          const domains = await new ResendClient(value).listDomains()
          return `resend ${domains.length} domain(s)`
        },
        updates
      )
    )

  if (Object.keys(updates).length) writeTokenFile(updates)
  else log(`\nnothing to write — ${TOKEN_FILE_LABEL} unchanged`)

  for (const o of outcomes) {
    const what =
      o.action === 'set'
        ? `set (${o.detail})`
        : o.action === 'kept'
          ? `kept (from ${o.source === 'env' ? 'environment' : 'file'})`
          : o.action === 'unverified'
            ? 'saved UNVERIFIED'
            : 'skipped'
    log(`  ${o.name.padEnd(22)} ${what}`)
  }
  const present = REQUIRED_TOKENS.filter(n => tokenSource(n))
  const missing = REQUIRED_TOKENS.filter(
    n => !tokenSource(n) && !(flags.skipEmail && n === 'RESEND_API_KEY')
  )
  verifyLine(
    `tokens ${missing.length ? 'incomplete' : 'ok'} — set: ${present.join(', ') || '-'}${missing.length ? `; missing: ${missing.join(', ')}` : ''} → ${TOKEN_FILE_LABEL} (0600). Next: pnpm provision preflight`
  )
  if (missing.length) process.exitCode = 2
}

/** Seed a new file from the example (so its comments come along), upsert, write 0600. */
export function writeTokenFile(updates: Record<string, string>): void {
  const current = fs.existsSync(TOKEN_FILE)
    ? fs.readFileSync(TOKEN_FILE, 'utf8')
    : fs.existsSync(TOKEN_FILE_EXAMPLE)
      ? fs.readFileSync(TOKEN_FILE_EXAMPLE, 'utf8')
      : ''
  const next = upsertEnvFile(current, updates)
  fs.writeFileSync(TOKEN_FILE, next, { mode: 0o600 })
  fs.chmodSync(TOKEN_FILE, 0o600)
  reloadTokenFile()
  log(`wrote ${Object.keys(updates).join(', ')} → ${TOKEN_FILE_LABEL} (mode 0600)`)
}
