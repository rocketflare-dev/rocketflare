/**
 * `pnpm web agent:replay <agentKey> --tenant <id|slug>` — replay an agent's settled runs with the
 * code in this working tree (`src/api/services/agents/replay.ts`), and say what would change.
 *
 *   --tenant <id|slug>   required; without it, the tenants that have runs of this agent are listed
 *   --since <7d|24h|ISO> only runs created since then          --limit <n>  newest n (default 20)
 *   --run <id>           one run                               --json       the full results
 *   --live               ask a real model for what the record cannot answer (costs tokens).
 *                        Reads the tenant's knowledge base and prompts as they are TODAY, through
 *                        the Worker's own resolver: the tenant's configs first, then the Workers AI
 *                        binding — borrowed from Cloudflare through wrangler (`wrangler login`) —
 *                        and it warns before starting when knowledge search would be degraded
 *   --candidate <file>   replay a module's default-exported agent instead of the registry's
 *                        (same `meta.key`) — how `rf-agent-tune` proves a compiled variant
 *   --db-url <url>       another database (default: DATABASE_URL from .dev.vars)
 *
 * Read-only by construction: every run replays inside a READ ONLY transaction. Exit 0 when every
 * run matches, 1 when any differs or could not be replayed, 2 on a usage error.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AGENT_KEYS, type AgentKey } from '@rocketflare/shared/ai/agents'
import { count, desc, eq, or } from 'drizzle-orm'
import { type AnyAgentDefinition, getAgent, isAgentKey } from '../src/api/services/agents/registry'
import {
  listReplayableRuns,
  liveReplayWarnings,
  type ReplayMode,
  type ReplayResult,
  replayRun,
} from '../src/api/services/agents/replay'
import type { RuntimeEnv } from '../src/api/services/agents/runtime'
import { loggerFor } from '../src/api/utils/core/logger'
import { loadConfig } from '../src/config'
import { closeAllDatabases, getScriptDatabase } from '../src/db/client'
import { agentRuns, tenants } from '../src/db/schema'

const USAGE = `usage: pnpm web agent:replay <agentKey> --tenant <id|slug> [--since 7d] [--limit 20]
                             [--run <id>] [--live] [--candidate <file>] [--json] [--db-url <url>]
agents: ${AGENT_KEYS.join(', ')}`

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (name === 'live' || name === 'json' || name === 'help') flags[name] = true
    else {
      const value = argv[++i]
      if (value === undefined) usage(`--${name} needs a value`)
      flags[name] = value
    }
  }
  return { positional, flags }
}

function usage(message?: string): never {
  if (message) console.error(message)
  console.error(USAGE)
  process.exit(2)
}

/** `7d`, `24h`, `90m`, or anything `Date` parses. */
function parseSince(value: string): Date {
  const m = /^(\d+)([dhm])$/.exec(value)
  if (m) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm']
    return new Date(Date.now() - Number(m[1]) * unit)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) usage(`--since: cannot read "${value}"`)
  return date
}

async function loadCandidate(file: string, key: AgentKey): Promise<AnyAgentDefinition> {
  const mod = (await import(pathToFileURL(resolve(process.cwd(), file)).href)) as {
    default?: AnyAgentDefinition
  }
  const agent = mod.default
  if (!agent?.meta || typeof agent.run !== 'function') {
    usage(`--candidate ${file}: the default export is not an agent definition`)
  }
  if (agent.meta.key !== key) {
    usage(`--candidate ${file}: its meta.key is "${agent.meta.key}", not "${key}"`)
  }
  return agent
}

/** Does the Worker have Workers AI? (`[ai]` uncommented — `pnpm bootstrap --offline` removes it.) */
function workerHasAi(): boolean {
  try {
    return /^\[ai\]\s*$/m.test(
      readFileSync(resolve(import.meta.dirname, '../wrangler.toml'), 'utf8')
    )
  } catch {
    return false
  }
}

/**
 * The Worker's `AI` binding, borrowed for a live replay — Workers AI has no local emulation, so
 * wrangler proxies it to Cloudflare exactly as `wrangler dev` does. Null (with a warning from the
 * caller) when wrangler cannot: not logged in, offline.
 */
async function borrowAiBinding(): Promise<{ ai: unknown; dispose: () => Promise<void> } | null> {
  process.env.WRANGLER_LOG ??= 'error'
  try {
    const { getPlatformProxy } = await import('wrangler')
    const proxy = await getPlatformProxy<{ AI?: unknown }>({
      configPath: resolve(import.meta.dirname, '../wrangler.toml'),
      persist: false,
    })
    if (!proxy.env.AI) {
      await proxy.dispose()
      return null
    }
    return { ai: proxy.env.AI, dispose: () => proxy.dispose() }
  } catch {
    return null
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function line(result: ReplayResult): string {
  const decisions = result.decisions
    .filter(d => d.status !== 'served')
    .map(d => `${d.key}:${d.status}${d.changed?.length ? `(${d.changed.length} changed)` : ''}`)
  const misses = result.misses.map(m => `${m.kind}:${m.key}`)
  return [
    result.verdict.padEnd(10),
    result.runId.slice(0, 8),
    `${result.recordedStatus} → ${result.replayStatus}`.padEnd(24),
    `diff ${result.outputDiff.length}`.padEnd(8),
    decisions.length ? `decisions ${decisions.join(' ')}` : '',
    misses.length ? `misses ${misses.join(' ')}` : '',
    result.writes.length ? `refused ${result.writes.length} write(s)` : '',
    result.error ? `— ${result.error}` : '',
  ]
    .filter(Boolean)
    .join('  ')
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2))
  if (flags.help) usage()
  const agentKey = positional[0]
  if (!agentKey) usage('Which agent?')
  if (!isAgentKey(agentKey)) usage(`Unknown agent "${agentKey}"`)

  const url = typeof flags['db-url'] === 'string' ? flags['db-url'] : process.env.DATABASE_URL
  if (!url) usage('No DATABASE_URL (apps/web/.dev.vars) and no --db-url')
  const db = getScriptDatabase(url, process.env)
  // The agents' own logs are noise beside the report unless asked for (`LOG_LEVEL=info`).
  const env = {
    ...process.env,
    APP_URL: process.env.APP_URL ?? 'http://localhost:3001',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  } as unknown as Cloudflare.Env
  const cfg = loadConfig(env)
  const logger = loggerFor(cfg, { script: 'agent-replay' })

  const disposers: (() => Promise<void>)[] = []
  try {
    const tenantArg = flags.tenant
    if (typeof tenantArg !== 'string') {
      const rows = await db
        .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, runs: count() })
        .from(agentRuns)
        .innerJoin(tenants, eq(tenants.id, agentRuns.tenantId))
        .where(eq(agentRuns.agentKey, agentKey))
        .groupBy(tenants.id, tenants.slug, tenants.name)
        .orderBy(desc(count()))
      console.error(
        rows.length
          ? `Pick a tenant with --tenant:\n${rows.map(r => `  ${r.slug.padEnd(24)} ${r.id}  ${r.runs} run(s)  ${r.name}`).join('\n')}`
          : `No tenant has a run of ${agentKey}.`
      )
      process.exit(2)
    }
    const tenant = await db.query.tenants.findFirst({
      columns: { id: true, slug: true },
      where: UUID.test(tenantArg)
        ? or(eq(tenants.id, tenantArg), eq(tenants.slug, tenantArg))
        : eq(tenants.slug, tenantArg),
    })
    if (!tenant) usage(`No tenant "${tenantArg}"`)

    const agent =
      typeof flags.candidate === 'string'
        ? await loadCandidate(flags.candidate, agentKey)
        : getAgent(agentKey)
    const mode: ReplayMode = flags.live ? 'live' : 'strict'
    if (mode === 'live') {
      const hasAi = workerHasAi()
      const borrowed = hasAi ? await borrowAiBinding() : null
      if (borrowed) {
        ;(env as unknown as { AI?: unknown }).AI = borrowed.ai
        disposers.push(borrowed.dispose)
      }
      const warnings = await liveReplayWarnings(db, cfg, env as unknown as RuntimeEnv, tenant.id, {
        workerHasAi: hasAi,
      })
      for (const warning of warnings) console.error(`⚠ live replay: ${warning}`)
    }
    const runs = await listReplayableRuns(db, {
      tenantId: tenant.id,
      agentKey,
      ...(typeof flags.since === 'string' && { since: parseSince(flags.since) }),
      ...(typeof flags.run === 'string' && { runId: flags.run }),
      limit: typeof flags.limit === 'string' ? Number(flags.limit) || 20 : 20,
    })
    if (runs.length === 0) {
      console.error(`No settled ${agentKey} runs in ${tenant.slug} for that window.`)
      process.exit(0)
    }

    const results: ReplayResult[] = []
    for (const run of runs) {
      const result = await replayRun(db, cfg, env as unknown as RuntimeEnv, run, agent, {
        mode,
        logger,
      })
      results.push(result)
      if (!flags.json) console.log(line(result))
    }

    if (flags.json) console.log(JSON.stringify(results, null, 2))
    else {
      const tally = (v: ReplayResult['verdict']) => results.filter(r => r.verdict === v).length
      const tokens = results.reduce(
        (sum, r) => sum + (r.liveUsage ? r.liveUsage.inputTokens + r.liveUsage.outputTokens : 0),
        0
      )
      console.log(
        `\n${results.length} run(s) replayed (${mode}${flags.candidate ? `, candidate ${flags.candidate}` : ''}): ${tally('match')} match, ${tally('differs')} differ, ${tally('incomplete')} incomplete${mode === 'live' ? ` — ${tokens} live tokens` : ''}`
      )
    }
    process.exitCode = results.every(r => r.verdict === 'match') ? 0 : 1
  } finally {
    await Promise.allSettled(disposers.map(d => d()))
    await closeAllDatabases()
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
