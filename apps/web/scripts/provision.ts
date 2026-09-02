/**
 * `pnpm provision <phase> [env] [flags]` — take a copy that runs locally to "deployed on
 * Cloudflare with Neon Postgres and Resend email". Driven by the `/provision` skill
 * (.claude/skills/provision/SKILL.md); the manual equivalent is SETUP.md Part 3.
 *
 * Phases (each idempotent find-or-create, each ending in ONE `Verify:` line):
 *   tokens [--skip-email]           TTY only: prompt (hidden) for the four vendor tokens, verify each
 *                                   against its vendor, write apps/web/.provision.env (0600)
 *   preflight                       tokens, tools, accounts, the four answers (cached), and the Cloudflare
 *                                   zone behind every custom host / the sending domain (DNS readable)
 *   email create|status|verify [env] Resend domain → DNS records in the Cloudflare zone → EMAIL_FROM;
 *                                   verify + mint the per-env sending key into RESEND_API_KEY
 *   neon                            project + `staging` branch, direct hosts, SELECT 1 per branch
 *   cloudflare <env>                scripts/cf-provision.sh <env> --apply (Hyperdrive/KV/Queue/R2 → toml ids)
 *   migrate <env>                   DATABASE_URL=<branch> pnpm db:migrate:ci, count == journal entries
 *   github <env>                    GitHub Environment + DATABASE_URL / CLOUDFLARE_* secrets (stdin)
 *   urls                            APP_URL + routes (custom host) or workers.dev per toml
 *   deploy <env>                    pnpm deploy[:staging] locally, then /api/health and /api/ready
 *   secrets <env>                   OAUTH_ENCRYPTION_KEY (generated) + every optional secret in env
 *   all [--deploy staging|both] [--skip-email] [--rotate]   0 → 9 in order, stops at the first failure
 *
 * Tokens (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY, RESEND_API_KEY; optional
 * BOOTSTRAP_ADMIN_EMAILS, GOOGLE_*, MICROSOFT_*, ANTHROPIC_API_KEY, EMBEDDINGS_API_KEY, LANGFUSE_*)
 * come from `process.env` first (CI), then the git-ignored `apps/web/.provision.env` (mode 0600,
 * written by `pnpm provision tokens` or copied from `.provision.env.example`) — never `.dev.vars`,
 * which `wrangler dev` loads into the Worker. Nothing else secret is written to disk:
 * `.provision.json` caches ids and answers, every printed line passes `redact()` (which also
 * masks the exact token values), connection strings reach child processes through their
 * environment or stdin only. The one exception is
 * inherited from cf-provision.sh: the Neon URL is briefly an argument to
 * `wrangler hyperdrive create --connection-string=…` (a process-local argv, redacted in output).
 *
 * Vendor REST calls (no vendor CLIs): scripts/provision/{neon,resend,cloudflare-dns}.ts carry the
 * verified API facts. wrangler runs as `pnpm exec wrangler` INSIDE apps/web.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import postgres from 'postgres'
import {
  CloudflareClient,
  hostsNeedingZone,
  missingZoneHint,
  WORKERS_DEV,
} from './provision/cloudflare-dns'
import {
  apexOf,
  capture,
  ENV_NAMES,
  type EnvName,
  heading,
  log,
  OPTIONAL_WORKER_SECRETS,
  ProvisionError,
  REQUIRED_TOKENS,
  ROOT_DIR,
  readAppName,
  readCache,
  requireToken,
  run,
  sleep,
  TOKEN_FILE_LABEL,
  TOKEN_HELP,
  token,
  tokenSource,
  tomlBasename,
  tomlFor,
  toUpperName,
  verifyLine,
  WEB_DIR,
  warn,
  wrangler,
  wranglerConfigArgs,
  writeCache,
} from './provision/config'
import {
  buildConnectionUrl,
  NeonClient,
  pickDatabase,
  pickEndpoint,
  pickRole,
} from './provision/neon'
import { patchTomlFile, readTomlString, tomlPlaceholders } from './provision/patch-toml'
import { redact } from './provision/redact'
import { emailFromFor, ResendClient, resendRecordsToDns, zoneCandidates } from './provision/resend'
import { generateHexKey, listWorkerSecrets, putWorkerSecret } from './provision/secrets'
import { tokensPhase } from './provision/tokens'

// ---- arguments ----------------------------------------------------------------------------

interface Flags {
  deploy: 'staging' | 'both'
  skipEmail: boolean
  rotate: boolean
  force: boolean
  debug: boolean
  help: boolean
  region?: string
  domain?: string
  emailRegion?: string
  stagingHost?: string
  productionHost?: string
  adminEmail?: string
}

const USAGE = `usage: pnpm provision <phase> [env] [flags]

phases
  tokens                             prompt for the four vendor tokens (hidden input, verified) → apps/web/.provision.env
  preflight                          check tools, tokens, accounts and the Cloudflare zone; record the answers
  email create | status | verify [env]   Resend domain + DNS records; verify and mint the sending key
  neon                               Neon project + staging branch (direct hosts, SELECT 1)
  cloudflare <staging|production>    Hyperdrive, KV, Queue, R2 → ids patched into the toml
  migrate <staging|production>       run the migrations against that branch
  github <staging|production>        GitHub Environment + DATABASE_URL / CLOUDFLARE_* secrets
  urls                               APP_URL + routes (custom host) or workers.dev in both tomls
  deploy <staging|production>        pnpm deploy[:staging], then /api/health and /api/ready
  secrets <staging|production>       OAUTH_ENCRYPTION_KEY + every optional secret in env or .provision.env
  all                                every phase in order; stops at the first failed Verify

flags
  --deploy staging|both              which environments \`all\` deploys (default staging)
  --skip-email                       no Resend: skip email create/verify (magic links are logged); tokens skips the Resend prompt
  --rotate                           regenerate OAUTH_ENCRYPTION_KEY / Neon passwords / RESEND key
  --region <neon region>             e.g. aws-us-east-1 (default)
  --domain <sending domain>          e.g. mail.example.com
  --email-region <resend region>     us-east-1 (default) | eu-west-1 | sa-east-1 | ap-northeast-1
  --staging-host <host|workers.dev>  custom host for staging, or the literal workers.dev
  --production-host <host|workers.dev>
  --admin-email <email>              BOOTSTRAP_ADMIN_EMAILS (default: git config user.email)
  --force                            overwrite a different existing id in a toml
  --debug                            print sanitised vendor payloads to stderr
  --help

tokens: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY, RESEND_API_KEY — an exported variable
wins (CI), else apps/web/.provision.env (git-ignored, 0600; \`pnpm provision tokens\` writes it, or copy
.provision.env.example). Never pasted into a chat, never printed. Optional Worker secrets copied by
\`secrets\` from the same two places: ${OPTIONAL_WORKER_SECRETS.join(', ')}.
Answers and ids are cached in apps/web/.provision.json (git-ignored, non-secret).`

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {
    deploy: 'staging',
    skipEmail: false,
    rotate: false,
    force: false,
    debug: false,
    help: false,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new ProvisionError(`${a} needs a value`, 2)
      return v
    }
    switch (a) {
      case '--help':
      case '-h':
        flags.help = true
        break
      case '--deploy': {
        const v = value()
        if (v !== 'staging' && v !== 'both')
          throw new ProvisionError('--deploy must be staging or both', 2)
        flags.deploy = v
        break
      }
      case '--skip-email':
        flags.skipEmail = true
        break
      case '--rotate':
        flags.rotate = true
        break
      case '--force':
        flags.force = true
        break
      case '--debug':
        flags.debug = true
        break
      case '--region':
        flags.region = value()
        break
      case '--domain':
        flags.domain = value()
        break
      case '--email-region':
        flags.emailRegion = value()
        break
      case '--staging-host':
        flags.stagingHost = value()
        break
      case '--production-host':
        flags.productionHost = value()
        break
      case '--admin-email':
        flags.adminEmail = value()
        break
      default:
        if (a.startsWith('--')) throw new ProvisionError(`unknown flag ${a}\n${USAGE}`, 2)
        positional.push(a)
    }
  }
  return { positional, flags }
}

function parseEnv(s: string | undefined, phase: string): EnvName {
  if (s === 'staging' || s === 'production') return s
  throw new ProvisionError(
    `${phase} needs an environment: pnpm provision ${phase} <staging|production>`,
    2
  )
}

// ---- answers ------------------------------------------------------------------------------

interface Answers {
  region: string
  domain: string | undefined
  hosts: Record<EnvName, string>
  adminEmails: string
  emailRegion: string
}

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = (await rl.question(`${question} [${fallback}]: `)).trim()
    return a || fallback
  } finally {
    rl.close()
  }
}

/** flags → cache → (TTY) prompt → default. In a non-TTY the domain and hosts must come from a flag or the cache. */
async function collectAnswers(flags: Flags): Promise<Answers> {
  const cache = readCache()
  const tty = process.stdin.isTTY
  const missing: string[] = []

  const region = flags.region ?? cache.region ?? (await ask('Neon region', 'aws-us-east-1'))
  const emailRegion = flags.emailRegion ?? cache.resend?.region ?? 'us-east-1'

  const prodUrl = readTomlString(fs.readFileSync(tomlFor('production'), 'utf8'), 'APP_URL') ?? ''
  const defaultDomain = `mail.${apexOf(prodUrl || 'example.com')}`
  let domain: string | undefined = flags.domain ?? cache.sendingDomain
  if (!domain && !flags.skipEmail) {
    if (tty) domain = await ask('Sending domain for Resend', defaultDomain)
    else missing.push(`--domain <sending domain>   (e.g. ${defaultDomain})`)
  }

  const hosts = {} as Record<EnvName, string>
  for (const env of ENV_NAMES) {
    const flag = env === 'staging' ? flags.stagingHost : flags.productionHost
    let h = flag ?? cache.hosts?.[env]
    if (!h) {
      if (tty)
        h = await ask(
          `${env} host (a hostname in your Cloudflare zone, or workers.dev)`,
          'workers.dev'
        )
      else missing.push(`--${env}-host <host|workers.dev>`)
    }
    hosts[env] = (h ?? '')
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
  }

  const gitEmail = capture('git', ['config', 'user.email'], ROOT_DIR) ?? ''
  const adminEmails =
    flags.adminEmail ??
    cache.adminEmails ??
    token('BOOTSTRAP_ADMIN_EMAILS') ??
    (await ask('Admin email (BOOTSTRAP_ADMIN_EMAILS)', gitEmail))

  if (missing.length) {
    throw new ProvisionError(
      `no TTY to ask questions — pass the answers as flags:\n  ${missing.join('\n  ')}\n(they are cached in apps/web/.provision.json after the first run)`,
      2
    )
  }
  for (const env of ENV_NAMES) {
    if (hosts[env] !== 'workers.dev' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hosts[env]))
      throw new ProvisionError(
        `--${env}-host must be a hostname or the literal workers.dev (got "${hosts[env]}")`,
        2
      )
  }
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain))
    throw new ProvisionError(`--domain "${domain}" is not a domain`, 2)

  writeCache({ region, sendingDomain: domain, hosts, adminEmails, resend: { region: emailRegion } })
  return { region, domain, hosts, adminEmails, emailRegion }
}

// ---- tokens -------------------------------------------------------------------------------

/**
 * The four vendor tokens, from the environment or `apps/web/.provision.env`. A missing one is an
 * exit 2 that says how to get it — `pnpm provision tokens` first (it needs the user's own
 * terminal), the example file, or an export — so `all` never tells the user to "re-run preflight".
 */
function requireTokens(flags: Flags, phase: string): void {
  const required = REQUIRED_TOKENS.filter(t => !(flags.skipEmail && t === 'RESEND_API_KEY'))
  const missing = required.filter(t => !token(t))
  if (!missing.length) return
  console.error(
    `\n${phase}: ${missing.length} token(s) missing. Run \`pnpm provision tokens\` in your own terminal (it prompts with hidden input and writes ${TOKEN_FILE_LABEL}), or copy apps/web/.provision.env.example to ${TOKEN_FILE_LABEL} and fill it in, or export the variables (CI):`
  )
  for (const m of missing)
    console.error(`  ${m}\n    mint: ${TOKEN_HELP[m].url}\n    scope: ${TOKEN_HELP[m].scopes}`)
  throw new ProvisionError(
    `${phase}: ${missing.join(', ')} missing — run \`pnpm provision tokens\` first`,
    2
  )
}

// ---- 0. preflight -------------------------------------------------------------------------

async function preflight(flags: Flags): Promise<void> {
  heading('preflight')
  const app = readAppName()
  const appUpper = toUpperName(app)
  writeCache({ appName: app })
  log(`app: ${app} (${appUpper}_RATE_LIMIT, ${app}-jobs, ${app}-files, ${app}-agent-run)`)

  const major = Number(process.versions.node.split('.')[0])
  if (major < 24)
    throw new ProvisionError(
      `node ${process.versions.node} — the kit needs Node 24 (nvm install reads .nvmrc)`
    )
  log(`node: v${process.versions.node}`)

  const remote = capture('git', ['remote', 'get-url', 'origin'], ROOT_DIR)
  if (!remote)
    throw new ProvisionError('git remote `origin` is not set — push the repo to GitHub first')
  log(`git remote: ${remote}`)
  if (capture('gh', ['auth', 'status']) === undefined)
    throw new ProvisionError(
      'gh is not authenticated — run `gh auth login` yourself, then re-run preflight'
    )
  log('gh: authenticated')

  requireTokens(flags, 'preflight')
  log(
    `tokens: ${REQUIRED_TOKENS.filter(t => tokenSource(t))
      .map(t => `${t} (${tokenSource(t)?.source})`)
      .join(', ')}`
  )

  const who = await wrangler(['whoami'], { echo: false })
  const accountId = token('CLOUDFLARE_ACCOUNT_ID') as string
  const accountLine = who.stdout.split('\n').find(l => l.includes(accountId))
  const accountName =
    accountLine
      ?.split('│')
      .map(s => s.trim())
      .filter(Boolean)[0] ?? accountId
  if (!accountLine)
    warn(
      `wrangler whoami does not list account ${accountId} — the token may belong to another account`
    )
  log(`cloudflare: ${accountName} (${accountId})`)

  const neon = new NeonClient(token('NEON_API_KEY') as string, fetch, flags.debug)
  const me = await neon.me()
  log(`neon: ${me.email}`)

  let resendSummary = 'skipped'
  if (!flags.skipEmail) {
    const resend = new ResendClient(token('RESEND_API_KEY') as string)
    const domains = await resend.listDomains()
    resendSummary = `${domains.length} domain(s)`
    log(`resend: ${resendSummary}`)
  }

  const answers = await collectAnswers(flags)
  log(
    `answers: region=${answers.region} domain=${answers.domain ?? '-'} staging=${answers.hosts.staging} production=${answers.hosts.production} admin=${answers.adminEmails}`
  )

  // Every custom host and the sending domain must be a zone in THIS account, and the token must be
  // able to read its DNS — otherwise `email create` / `urls` / the first deploy fail much later.
  const needed = hostsNeedingZone(answers, flags.skipEmail)
  let zoneSummary = `none (${WORKERS_DEV} hosts, email skipped)`
  if (needed.length) {
    const cf = cfClient()
    const zones = new Map<string, { zone: Zone; names: string[] }>()
    for (const name of needed) {
      const zone = await requireZone(cf, name)
      const entry = zones.get(zone.id) ?? { zone, names: [] }
      if (!entry.names.length) await cf.assertDnsRead(zone)
      entry.names.push(name)
      zones.set(zone.id, entry)
    }
    for (const { zone, names } of zones.values())
      log(`zone: ${zone.name} (${zone.id}) — DNS readable; for ${names.join(', ')}`)
    zoneSummary = [...zones.values()].map(({ zone }) => `${zone.name} (${zone.id})`).join(', ')
  }
  verifyLine(
    `preflight ok — app=${app} account=${accountName} neon=${me.email} resend=${resendSummary} zone=${zoneSummary}`
  )
}

// ---- 1 / 9. email -------------------------------------------------------------------------

function resendClient(): ResendClient {
  return new ResendClient(requireToken('RESEND_API_KEY'))
}
function cfClient(): CloudflareClient {
  return new CloudflareClient(requireToken('CLOUDFLARE_API_TOKEN'))
}

interface Zone {
  id: string
  name: string
}

/**
 * The zone a host or sending domain lives in: the cache first (an EXACT match on the
 * `zoneCandidates` walk — `notexample.com` never matches `example.com`), then `GET /zones?name=`
 * per candidate; a hit is cached under its real name so `email create` / `urls` never look again.
 */
async function lookupZone(cf: CloudflareClient, name: string): Promise<Zone | undefined> {
  const cached = readCache().cloudflare
  const known: Record<string, string> = { ...(cached?.zones ?? {}) }
  if (cached?.zoneId && cached.zoneName) known[cached.zoneName] ??= cached.zoneId
  const candidates = zoneCandidates(name)
  for (const c of candidates) if (known[c]) return { id: known[c], name: c }
  const zone = await cf.findZoneFor(candidates)
  if (!zone) return undefined
  writeCache({
    cloudflare: {
      zoneId: cached?.zoneId ?? zone.id,
      zoneName: cached?.zoneName ?? zone.name,
      zones: { [zone.name]: zone.id },
    },
  })
  return { id: zone.id, name: zone.name }
}

/** `lookupZone`, failing with the one hint for a domain that is not on the account. */
async function requireZone(cf: CloudflareClient, name: string): Promise<Zone> {
  const zone = await lookupZone(cf, name)
  if (zone) return zone
  if (!(await cf.hasAnyZone()))
    warn(
      'the token sees no zones at all — if the domain IS on this account, CLOUDFLARE_API_TOKEN is missing its Zone scope (Zone: DNS — Edit)'
    )
  throw new ProvisionError(missingZoneHint(apexOf(name)))
}

async function findOrCreateDomain(flags: Flags) {
  const answers = await collectAnswers(flags)
  const domainName = answers.domain
  if (!domainName) throw new ProvisionError('no sending domain — pass --domain', 2)
  const resend = resendClient()
  let domain = (await resend.listDomains()).find(d => d.name === domainName)
  let created = false
  if (!domain) {
    domain = await resend.createDomain(domainName, answers.emailRegion)
    created = true
  }
  const full = await resend.getDomain(domain.id)
  writeCache({ resend: { domainId: full.id, domainName: full.name, region: full.region } })
  return { domain: full, created }
}

async function emailCreate(flags: Flags): Promise<void> {
  heading('email create')
  const { domain, created } = await findOrCreateDomain(flags)
  log(
    `resend domain: ${domain.name} ${created ? 'created' : 'exists'} (status ${domain.status}, region ${domain.region ?? '?'})`
  )
  const records = resendRecordsToDns(domain.records ?? [], domain.name)
  if (!records.length) throw new ProvisionError('Resend returned no DNS records for the domain')

  const cf = cfClient()
  const zone = await requireZone(cf, domain.name)
  log(`cloudflare zone: ${zone.name} (${zone.id})`)

  const counts = { exists: 0, created: 0, updated: 0 }
  for (const rec of records) {
    const outcome = await cf.upsertRecord(zone.id, rec)
    counts[outcome]++
    log(
      `  ${outcome.padEnd(7)} ${rec.type.padEnd(5)} ${rec.name}${rec.priority !== undefined ? ` (priority ${rec.priority})` : ''}`
    )
  }

  const app = readAppName()
  const appName = readTomlString(fs.readFileSync(tomlFor('production'), 'utf8'), 'APP_NAME') ?? app
  const emailFrom = emailFromFor(appName, domain.name)
  for (const env of ENV_NAMES) {
    const changed = patchTomlFile(tomlFor(env), { emailFrom })
    log(`${tomlBasename(env)}: EMAIL_FROM ${changed ? 'set' : 'unchanged'}`)
  }
  verifyLine(
    `email create ok — domain=${domain.name} zone=${zone.name} records=${records.length} (created ${counts.created}, updated ${counts.updated}, existing ${counts.exists}) EMAIL_FROM="${emailFrom}"`
  )
}

async function emailStatus(flags: Flags): Promise<void> {
  heading('email status')
  const { domain } = await findOrCreateDomain(flags)
  const cf = cfClient()
  const zone = await lookupZone(cf, domain.name)
  if (!zone) warn(missingZoneHint(apexOf(domain.name)))
  const records = resendRecordsToDns(domain.records ?? [], domain.name)
  let present = 0
  for (const [i, rec] of records.entries()) {
    const found = zone ? (await cf.listRecords(zone.id, rec.name, rec.type)).length > 0 : false
    if (found) present++
    log(
      `  ${found ? 'present' : 'MISSING'}  ${rec.type.padEnd(5)} ${rec.name}   resend: ${domain.records?.[i]?.status ?? '?'}`
    )
  }
  verifyLine(
    `email status — domain=${domain.name} status=${domain.status} dns=${present}/${records.length} present`
  )
}

async function emailVerify(env: EnvName, flags: Flags): Promise<void> {
  heading(`email verify ${env}`)
  const { domain } = await findOrCreateDomain(flags)
  const resend = resendClient()
  let status = domain.status
  if (status !== 'verified') {
    await resend.verifyDomain(domain.id)
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      await sleep(15_000)
      status = (await resend.getDomain(domain.id)).status
      log(`  ${domain.name}: ${status}`)
      if (status === 'verified') break
      if (status === 'failed')
        throw new ProvisionError(
          `Resend reports ${domain.name} as failed — run \`pnpm provision email status\``
        )
    }
    if (status !== 'verified')
      throw new ProvisionError(
        `DNS still propagating — Resend reports "${status}" after 10 min; re-run \`pnpm provision email verify ${env}\` later`
      )
  }
  log(`resend domain: ${domain.name} verified`)

  const existing = await listWorkerSecrets(env)
  if (existing.includes('RESEND_API_KEY') && !flags.rotate) {
    log('RESEND_API_KEY already set on the Worker (pass --rotate to mint a new key)')
  } else {
    const key = await resend.createSendingKey(`${readAppName()}-${env}`, domain.id)
    await putWorkerSecret(env, 'RESEND_API_KEY', key.token)
    log(
      `RESEND_API_KEY: minted sending key "${readAppName()}-${env}" (id ${key.id}) and set on the ${env} Worker`
    )
  }

  const appUrl = readTomlString(fs.readFileSync(tomlFor(env), 'utf8'), 'APP_URL') ?? ''
  const methods = await fetchJson(`${appUrl}/auth/methods`)
  const magic = methods?.magicLink === true
  if (!magic)
    throw new ProvisionError(
      `${appUrl}/auth/methods does not report magicLink — is the Worker deployed?`
    )
  verifyLine(
    `email verify ${env} ok — domain=${domain.name} verified, RESEND_API_KEY set, ${appUrl}/auth/methods reports magic link`
  )
}

// ---- 2. neon ------------------------------------------------------------------------------

interface NeonBranchInfo {
  branchId: string
  host: string
  /** In memory only. */
  url: string
}

let neonMemo: Promise<Record<EnvName, NeonBranchInfo>> | undefined

/**
 * Resolved ONCE per process: `cloudflare`, `migrate` and `github` all need the URLs, and a
 * `--rotate` must reset each password exactly once (only `neonPhase` passes `rotate`), or the
 * Hyperdrive created a moment earlier would hold a stale password.
 */
function resolveNeon(
  flags: Flags,
  opts: { quiet?: boolean; rotate?: boolean } = {}
): Promise<Record<EnvName, NeonBranchInfo>> {
  neonMemo ??= resolveNeonUncached(flags, opts)
  return neonMemo
}

async function resolveNeonUncached(
  flags: Flags,
  opts: { quiet?: boolean; rotate?: boolean }
): Promise<Record<EnvName, NeonBranchInfo>> {
  const say = opts.quiet ? () => {} : log
  const rotate = opts.rotate ?? false
  const neon = new NeonClient(requireToken('NEON_API_KEY'), fetch, flags.debug)
  const answers = await collectAnswers(flags)
  const app = readAppName()
  const cache = readCache()

  const found = await neon.findProject(app)
  let createdProject = false
  let project: { id: string; name: string; region_id: string }
  if (found) project = found
  else {
    say(`neon project: creating "${app}" in ${answers.region} (pg 17)…`)
    project = await neon.createProject(app, answers.region)
    createdProject = true
  }
  say(
    `neon project: ${project.name} (${project.id}) ${createdProject ? 'created' : 'exists'} region=${project.region_id}`
  )

  const branches = await neon.listBranches(project.id)
  const main = branches.find(b => b.default || b.primary) ?? branches[0]
  if (!main) throw new ProvisionError('the Neon project has no default branch')
  let stagingBranch = branches.find(b => b.name === 'staging')
  let createdStaging = false
  if (!stagingBranch) {
    say('neon branch: creating "staging" from the default branch…')
    stagingBranch = await neon.createBranch(project.id, 'staging', main.id)
    createdStaging = true
  }
  say(
    `neon branches: production=${main.name} (${main.id}) staging=${stagingBranch.name} (${stagingBranch.id}) ${createdStaging ? 'created' : 'exists'}`
  )

  const out = {} as Record<EnvName, NeonBranchInfo>
  const hosts: Partial<Record<EnvName, string>> = {}
  const rotated: EnvName[] = []
  let dbName = cache.neon?.database
  let roleName = cache.neon?.role
  for (const [env, branch, fresh] of [
    ['production', main, createdProject],
    ['staging', stagingBranch, createdStaging || createdProject],
  ] as const) {
    const endpoint = pickEndpoint(await neon.listEndpoints(project.id, branch.id))
    const db = pickDatabase(await neon.listDatabases(project.id, branch.id))
    const role = pickRole(await neon.listRoles(project.id, branch.id), db.owner_name)
    dbName = db.name
    roleName = role
    let password: string | undefined
    if (fresh || rotate) {
      password = await neon.resetPassword(project.id, branch.id, role)
      say(`  ${env}: password ${rotate && !fresh ? 'rotated' : 'set'} for role ${role}`)
      rotated.push(env)
    } else {
      password = await neon.revealPassword(project.id, branch.id, role)
      if (!password) {
        warn(
          `Neon does not store passwords for this project — resetting the ${role} password on ${env}`
        )
        password = await neon.resetPassword(project.id, branch.id, role)
      }
    }
    const url = buildConnectionUrl({ role, password, host: endpoint.host, database: db.name })
    await waitForSelectOne(url, env)
    hosts[env] = endpoint.host
    out[env] = { branchId: branch.id, host: endpoint.host, url }
    say(`  ${env}: host=${endpoint.host} db=${db.name} role=${role} SELECT 1 ok`)
  }
  writeCache({
    neon: {
      projectId: project.id,
      branches: { production: main.id, staging: stagingBranch.id },
      hosts,
      database: dbName,
      role: roleName,
    },
  })
  for (const env of rotated) await syncHyperdrivePassword(env, out[env].url, say)
  return out
}

/** After a password reset an EXISTING Hyperdrive config (reused by name) must learn the new credential. */
async function syncHyperdrivePassword(env: EnvName, url: string, say: (s: string) => void) {
  const id = hyperdriveIdFor(env)
  if (!id) return
  // Same caveat as cf-provision.sh: the URL is an argv of this one wrangler process; output is redacted.
  await wrangler(
    ['hyperdrive', 'update', id, `--connection-string=${url}`, ...wranglerConfigArgs(env)],
    { echo: false }
  )
  say(`  ${env}: Hyperdrive ${id} updated with the rotated password`)
}

function hyperdriveIdFor(env: EnvName): string | undefined {
  const m = /binding = "HYPERDRIVE"\n(?:[^\n]*\n)*?id = "([0-9a-f]{32})"/.exec(
    fs.readFileSync(tomlFor(env), 'utf8')
  )
  return m?.[1]
}

/** Neon computes scale to zero; the first connection can take a few seconds to wake one. */
async function waitForSelectOne(url: string, label: string, attempts = 10): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    const sql = postgres(url, { max: 1, connect_timeout: 20, onnotice: () => {} })
    try {
      await sql`SELECT 1`
      return
    } catch (err) {
      if (i === attempts)
        throw new ProvisionError(
          `${label}: SELECT 1 failed after ${attempts} attempts: ${redact(String(err))}`
        )
      if (i === 1) log(`  ${label}: waiting for the compute to wake…`)
      await sleep(4000)
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {})
    }
  }
}

async function neonPhase(flags: Flags): Promise<void> {
  heading('neon')
  const info = await resolveNeon(flags, { rotate: flags.rotate })
  verifyLine(
    `neon ok — production=${info.production.host} staging=${info.staging.host} (SELECT 1 on both)`
  )
}

// ---- 3. cloudflare ------------------------------------------------------------------------

function bothProvisioned(): boolean {
  return ENV_NAMES.every(
    env => tomlPlaceholders(fs.readFileSync(tomlFor(env), 'utf8')).length === 0
  )
}

async function parityTest(provisioned: boolean): Promise<void> {
  await run('pnpm', ['test:config'], {
    cwd: WEB_DIR,
    env: provisioned ? { REQUIRE_PROVISIONED: '1' } : {},
  })
}

async function cloudflarePhase(env: EnvName, flags: Flags): Promise<void> {
  heading(`cloudflare ${env}`)
  const info = await resolveNeon(flags, { quiet: true })
  // The URL travels in the child's environment; cf-provision.sh hands it to
  // `wrangler hyperdrive create --connection-string=` (an argv of that one process) and redacts its output.
  await run(
    'bash',
    ['scripts/cf-provision.sh', env, '--apply', ...(flags.force ? ['--force'] : [])],
    {
      cwd: WEB_DIR,
      env: {
        NEON_DATABASE_URL: info[env].url,
        CLOUDFLARE_API_TOKEN: token('CLOUDFLARE_API_TOKEN'),
        CLOUDFLARE_ACCOUNT_ID: token('CLOUDFLARE_ACCOUNT_ID'),
      },
    }
  )
  const left = tomlPlaceholders(fs.readFileSync(tomlFor(env), 'utf8'))
  if (left.length) throw new ProvisionError(`${tomlBasename(env)} still has ${left.join(', ')}`)
  await run(
    'git',
    ['diff', '--stat', '--', 'apps/web/wrangler.toml', 'apps/web/wrangler.staging.toml'],
    { cwd: ROOT_DIR }
  )
  if (bothProvisioned()) {
    await parityTest(true)
    verifyLine(
      `cloudflare ${env} ok — ${tomlBasename(env)} patched; REQUIRE_PROVISIONED=1 parity test passed for both tomls`
    )
  } else {
    const other = env === 'staging' ? 'production' : 'staging'
    verifyLine(
      `cloudflare ${env} ok — ${tomlBasename(env)} patched; run \`pnpm provision cloudflare ${other}\` and the provisioned parity test runs then`
    )
  }
}

// ---- 4. migrate ---------------------------------------------------------------------------

function journalCount(): number {
  const journal = JSON.parse(
    fs.readFileSync(path.join(WEB_DIR, 'migrations/meta/_journal.json'), 'utf8')
  )
  return (journal.entries ?? []).length
}

async function migratePhase(env: EnvName, flags: Flags): Promise<void> {
  heading(`migrate ${env}`)
  const info = await resolveNeon(flags, { quiet: true })
  await run('pnpm', ['db:migrate:ci'], { cwd: WEB_DIR, env: { DATABASE_URL: info[env].url } })
  const sql = postgres(info[env].url, { max: 1, connect_timeout: 20, onnotice: () => {} })
  let applied = 0
  try {
    const [row] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`
    applied = Number(row?.n ?? 0)
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {})
  }
  const expected = journalCount()
  if (applied !== expected)
    throw new ProvisionError(
      `migrate ${env}: ${applied} applied but the journal has ${expected} entries`
    )
  verifyLine(`migrate ${env} ok — ${applied}/${expected} migrations applied on ${info[env].host}`)
}

// ---- 5. github ----------------------------------------------------------------------------

function repoSlug(): string {
  const remote = capture('git', ['remote', 'get-url', 'origin'], ROOT_DIR) ?? ''
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote)
  if (!m) throw new ProvisionError(`origin "${remote}" is not a GitHub remote`)
  return `${m[1]}/${m[2]}`
}

async function githubPhase(env: EnvName, flags: Flags): Promise<void> {
  heading(`github ${env}`)
  const info = await resolveNeon(flags, { quiet: true })
  const repo = repoSlug()
  await run('gh', ['api', '-X', 'PUT', `repos/${repo}/environments/${env}`, '--silent'], {
    cwd: ROOT_DIR,
    echo: false,
  })
  log(`github environment: ${repo} / ${env}`)
  const secrets: Record<string, string> = {
    DATABASE_URL: info[env].url,
    CLOUDFLARE_API_TOKEN: token('CLOUDFLARE_API_TOKEN') as string,
    CLOUDFLARE_ACCOUNT_ID: token('CLOUDFLARE_ACCOUNT_ID') as string,
  }
  for (const [name, value] of Object.entries(secrets)) {
    await run('gh', ['secret', 'set', name, '-e', env, '-R', repo], {
      cwd: ROOT_DIR,
      stdin: value,
      echo: false,
    })
    log(`  set ${name}`)
  }
  const list = await run('gh', ['secret', 'list', '-e', env, '-R', repo, '--json', 'name'], {
    cwd: ROOT_DIR,
    echo: false,
  })
  const names = (JSON.parse(list.stdout) as { name: string }[]).map(s => s.name)
  const missing = Object.keys(secrets).filter(n => !names.includes(n))
  if (missing.length)
    throw new ProvisionError(`github ${env}: secrets missing after set: ${missing.join(', ')}`)
  verifyLine(
    `github ${env} ok — environment ${env} on ${repo} has ${Object.keys(secrets).join(', ')}`
  )
}

// ---- 6. urls ------------------------------------------------------------------------------

async function urlsPhase(flags: Flags): Promise<void> {
  heading('urls')
  const answers = await collectAnswers(flags)
  const urls: Record<EnvName, string> = { staging: '', production: '' }
  const zoneNote: Partial<Record<EnvName, string>> = {}
  for (const env of ENV_NAMES) {
    const host = answers.hosts[env]
    const text = fs.readFileSync(tomlFor(env), 'utf8')
    const workerName = readTomlString(text, 'name') ?? readAppName()
    if (host === WORKERS_DEV) {
      let sub = readCache().cloudflare?.workersSubdomain
      if (!sub) {
        sub = await cfClient().workersSubdomain(requireToken('CLOUDFLARE_ACCOUNT_ID'))
        writeCache({ cloudflare: { workersSubdomain: sub } })
      }
      urls[env] = `https://${workerName}.${sub}.workers.dev`
      patchTomlFile(tomlFor(env), {
        appUrl: urls[env],
        workersDevComment:
          "workers_dev = true is wrangler's default while `routes` stays commented, so this Worker is\n" +
          `served at ${urls[env]} (note added by \`pnpm provision urls\`).`,
      })
    } else {
      // The custom domain route is created by `wrangler deploy` in this zone — prove it exists now.
      const zone = await requireZone(cfClient(), host)
      urls[env] = `https://${host}`
      patchTomlFile(tomlFor(env), { appUrl: urls[env], routeHost: host })
      zoneNote[env] = ` routes=[${host}] zone=${zone.name}`
    }
    log(`${tomlBasename(env)}: APP_URL=${urls[env]}${zoneNote[env] ?? ''}`)
  }
  const provisioned = bothProvisioned()
  await parityTest(provisioned)
  verifyLine(
    `urls ok — staging=${urls.staging} production=${urls.production}; parity test passed${provisioned ? ' (provisioned)' : ''}`
  )
}

// ---- 7. deploy ----------------------------------------------------------------------------

async function fetchJson(url: string, attempts = 6): Promise<any> {
  let last: any
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      const body = await res.json().catch(() => ({}))
      last = { status: res.status, body }
      if (res.ok) return body
      if (res.status === 503) return { ...(body as object), __status: 503 }
    } catch (err) {
      last = err
    }
    if (i < attempts) await sleep(5000)
  }
  throw new ProvisionError(
    `${url}: ${redact(typeof last === 'string' ? last : JSON.stringify(last))}`
  )
}

async function deployPhase(env: EnvName): Promise<void> {
  heading(`deploy ${env}`)
  const appUrl = readTomlString(fs.readFileSync(tomlFor(env), 'utf8'), 'APP_URL')
  if (!appUrl) throw new ProvisionError(`${tomlBasename(env)} has no APP_URL`)
  await run('pnpm', [env === 'staging' ? 'deploy:staging' : 'deploy'], {
    cwd: WEB_DIR,
    env: {
      CLOUDFLARE_API_TOKEN: token('CLOUDFLARE_API_TOKEN'),
      CLOUDFLARE_ACCOUNT_ID: token('CLOUDFLARE_ACCOUNT_ID'),
    },
  })
  const list = await wrangler(['deployments', 'list', '--json', ...wranglerConfigArgs(env)], {
    echo: false,
  })
  const deployments = JSON.parse(list.stdout.slice(list.stdout.indexOf('['))) as any[]
  log(`deployments: ${deployments.length} listed`)
  const health = await fetchJson(`${appUrl}/api/health`)
  if (health?.status !== 'ok')
    throw new ProvisionError(`${appUrl}/api/health → ${JSON.stringify(health)}`)
  const ready = await fetchJson(`${appUrl}/api/ready`)
  if (ready?.__status === 503 || ready?.status !== 'ready')
    throw new ProvisionError(
      `${appUrl}/api/ready → ${JSON.stringify(ready)} — the Worker cannot reach Postgres through Hyperdrive: check the Hyperdrive config points at the DIRECT Neon host with sslmode=require (pnpm provision cloudflare ${env} --force after fixing)`
    )
  verifyLine(
    `deploy ${env} ok — ${appUrl}/api/health ok (version ${health.version}), /api/ready ok, deployments listed`
  )
}

// ---- 8. secrets ---------------------------------------------------------------------------

async function secretsPhase(env: EnvName, flags: Flags): Promise<void> {
  heading(`secrets ${env}`)
  const existing = await listWorkerSecrets(env)
  const set: string[] = []
  const skipped: string[] = []
  if (!existing.includes('OAUTH_ENCRYPTION_KEY') || flags.rotate) {
    if (existing.includes('OAUTH_ENCRYPTION_KEY'))
      warn(
        'rotating OAUTH_ENCRYPTION_KEY invalidates every tenant AI credential and stored OAuth token — admins must re-enter them (docs/DEPLOY.md → Rollback)'
      )
    await putWorkerSecret(env, 'OAUTH_ENCRYPTION_KEY', generateHexKey())
    set.push('OAUTH_ENCRYPTION_KEY')
  } else log('OAUTH_ENCRYPTION_KEY already set (pass --rotate to regenerate)')

  const answers = await collectAnswers(flags)
  for (const name of OPTIONAL_WORKER_SECRETS) {
    const value =
      name === 'BOOTSTRAP_ADMIN_EMAILS' ? (token(name) ?? answers.adminEmails) : token(name)
    if (!value) {
      skipped.push(name)
      continue
    }
    await putWorkerSecret(env, name, value) // never DATABASE_URL — deployed Workers use HYPERDRIVE
    set.push(name)
  }
  const after = await listWorkerSecrets(env)
  const missing = set.filter(n => !after.includes(n))
  if (missing.length)
    throw new ProvisionError(`secrets ${env}: not listed after put: ${missing.join(', ')}`)
  log(
    `set: ${set.length} (${set.join(', ') || '-'}), skipped (unset): ${skipped.length} (${skipped.join(', ') || '-'})`
  )
  verifyLine(
    `secrets ${env} ok — wrangler secret list shows ${after.length} secret(s): ${after.sort().join(', ')}`
  )
}

// ---- 10. all ------------------------------------------------------------------------------

function closeOut(flags: Flags, deployed: EnvName[]): void {
  const cache = readCache()
  const urls = Object.fromEntries(
    ENV_NAMES.map(env => [env, readTomlString(fs.readFileSync(tomlFor(env), 'utf8'), 'APP_URL')])
  ) as Record<EnvName, string | undefined>
  console.log(`
== close-out checklist ==
1. Sign in: open ${urls[deployed[0]]}/login and request a magic link for ${cache.adminEmails ?? 'your admin email'}.
   ${flags.skipEmail ? 'Email is skipped: copy the link from `pnpm web exec wrangler tail' + (deployed[0] === 'staging' ? ' -c wrangler.staging.toml' : '') + '`.' : 'It arrives from the verified Resend domain.'}
   With SIGNUP_MODE=invite_only the first login lands on /pending — you are the global admin: create the
   first organisation at ${urls[deployed[0]]}/admin.
2. OAuth (optional): add these redirect URIs to each provider, then \`pnpm provision secrets <env>\` with
   GOOGLE_* / MICROSOFT_* exported:${ENV_NAMES.map(env => `\n     ${urls[env]}/auth/google/callback   ${urls[env]}/auth/microsoft/callback`).join('')}
3. Commit the provisioned tomls (ids and URLs are not secrets):
     git add apps/web/wrangler.toml apps/web/wrangler.staging.toml && git commit -m "chore: provision cloudflare" && git push
4. CI deploys from now on: tag X.Y.Z → staging, publish the Release → production (docs/DEPLOY.md), or
   right away: gh workflow run deploy.yml -f environment=staging
5. CLI: pnpm cli login --server ${urls[deployed[0]]}
${deployed.length === 1 ? `6. Production is provisioned and migrated but NOT deployed: \`pnpm provision deploy production\` then\n   \`pnpm provision secrets production\`${flags.skipEmail ? '' : ' and `pnpm provision email verify production`'}, or publish a Release.\n` : ''}`)
}

async function allPhase(flags: Flags): Promise<void> {
  requireTokens(flags, 'all')
  const deployed: EnvName[] = flags.deploy === 'both' ? ['staging', 'production'] : ['staging']
  const steps: Array<[string, () => Promise<void>]> = [
    ['preflight', () => preflight(flags)],
    ...(flags.skipEmail
      ? []
      : [['email create', () => emailCreate(flags)] as [string, () => Promise<void>]]),
    ['neon', () => neonPhase(flags)],
    ...ENV_NAMES.map(
      env =>
        [`cloudflare ${env}`, () => cloudflarePhase(env, flags)] as [string, () => Promise<void>]
    ),
    ...ENV_NAMES.map(
      env => [`migrate ${env}`, () => migratePhase(env, flags)] as [string, () => Promise<void>]
    ),
    ...ENV_NAMES.map(
      env => [`github ${env}`, () => githubPhase(env, flags)] as [string, () => Promise<void>]
    ),
    ['urls', () => urlsPhase(flags)],
    ...deployed.map(
      env => [`deploy ${env}`, () => deployPhase(env)] as [string, () => Promise<void>]
    ),
    ...deployed.map(
      env => [`secrets ${env}`, () => secretsPhase(env, flags)] as [string, () => Promise<void>]
    ),
    ...(flags.skipEmail
      ? []
      : deployed.map(
          env =>
            [`email verify ${env}`, () => emailVerify(env, flags)] as [string, () => Promise<void>]
        )),
  ]
  for (const [name, fn] of steps) {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new ProvisionError(
        `phase "${name}" failed: ${msg}\n→ fix the cause and re-run \`pnpm provision ${name}\` (then \`pnpm provision all\` continues idempotently)`,
        err instanceof ProvisionError ? err.exitCode : 1
      )
    }
  }
  closeOut(flags, deployed)
  verifyLine(`all ok — ${steps.length} phases passed; deployed ${deployed.join(', ')}`)
}

// ---- main ---------------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv)
  const [phase, a, b] = positional
  if (flags.help || !phase) {
    console.log(USAGE)
    if (!phase && !flags.help) process.exitCode = 2
    return
  }
  switch (phase) {
    case 'tokens':
      return tokensPhase(flags)
    case 'preflight':
      return preflight(flags)
    case 'email': {
      if (a === 'create') return emailCreate(flags)
      if (a === 'status') return emailStatus(flags)
      if (a === 'verify') return emailVerify(parseEnv(b, 'email verify'), flags)
      throw new ProvisionError('email needs create | status | verify <env>', 2)
    }
    case 'neon':
      return neonPhase(flags)
    case 'cloudflare':
      return cloudflarePhase(parseEnv(a, phase), flags)
    case 'migrate':
      return migratePhase(parseEnv(a, phase), flags)
    case 'github':
      return githubPhase(parseEnv(a, phase), flags)
    case 'urls':
      return urlsPhase(flags)
    case 'deploy':
      return deployPhase(parseEnv(a, phase))
    case 'secrets':
      return secretsPhase(parseEnv(a, phase), flags)
    case 'all':
      return allPhase(flags)
    default:
      throw new ProvisionError(`unknown phase "${phase}"\n${USAGE}`, 2)
  }
}

main(process.argv.slice(2)).catch(err => {
  const code = err instanceof ProvisionError ? err.exitCode : 1
  console.error(redact(`\nerror: ${err instanceof Error ? err.message : String(err)}`))
  process.exitCode = code
})
