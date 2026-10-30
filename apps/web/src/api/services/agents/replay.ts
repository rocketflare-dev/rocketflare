/**
 * Replay: run an agent's CURRENT code over a run it already did, answering every recorded
 * question from the record, and report what would change — without a model call (`strict`) or with
 * only the calls the record cannot answer (`live`). The point is the change you are about to make:
 * a new threshold, a reworded decision, a decomposed `run()` — checked against a thousand past
 * cases in minutes instead of against production.
 *
 * What a run recorded, and what the replay context serves from it:
 *   `ctx.decide`     `agent_run_decisions` by key. Same questions about the same state → the
 *                    recorded answer (`served`). Reworded questions whose ids are a subset of the
 *                    recorded ones (`drift`), or the same questions about a different state —
 *                    upstream code changed what the decision is about (`stale`) — are answered from
 *                    the record in strict mode and flagged; live mode asks again. A key with no
 *                    record, or questions the record cannot answer → a miss (strict) or a live ask.
 *   `ctx.once`       `agent_run_effects.result` by key. A missing key is a miss in both modes — `fn`
 *                    may have a side effect — unless the call is marked `{ replay: 'rerun' }`, which
 *                    live mode runs again (a pure model call whose prompt may have changed). A
 *                    `ctx.map` item (`{ replay: 'inner' }`) is run again in BOTH modes: its
 *                    result is a cache, and what it asks inside its scope is answered from the
 *                    record by the scoped key (`items[3]/relevant`), like any other call.
 *   `ctx.interrupt`  `agent_run_interrupts` by key, with the runtime's own rejection semantics. No
 *                    answered row → the replay stops `parked`.
 *   `ctx.steering`   the run's `steering` events, all handed over on the first call — an
 *                    approximation: the run itself saw them when they arrived.
 *   chat, tools      strict: a miss. live: the real client and the real (read-only) tools —
 *                    so a live replay reads the tenant's knowledge base, prompts and model
 *                    choice as they are TODAY, not as they were (`liveReplayWarnings` says when
 *                    knowledge search would be degraded in the replaying process).
 *   events, artifacts, the checkpoint — captured in memory.
 *
 * **Nothing is written, and the database says so.** Each run replays inside a READ ONLY
 * transaction, and `ctx.db` refuses `insert`/`update`/`delete` before the SQL is sent (an agent may
 * write directly — `recordUsage` in a `once`). A refused write is listed in `writes`, not a miss: a
 * replay that never needed it still compares. Only a write the agent did not catch fails the run.
 *
 * The agent is the one in the working tree (`getAgent`), or a candidate a caller hands in — the
 * hook `rf-agent-tune` uses to prove a compiled variant against the full agent's history.
 */
import type { AgentKey, AgentRunStatus } from '@rocketflare/shared/ai/agents'
import type { AgentArtifact } from '@rocketflare/shared/ai/artifacts'
import { agentArtifactInputSchema } from '@rocketflare/shared/ai/artifacts'
import type { TokenUsage } from '@rocketflare/shared/ai/chat'
import {
  type DecisionAnswers,
  type DecisionRequest,
  decisionAnswerLabel,
  decisionRequestSchema,
} from '@rocketflare/shared/ai/decisions'
import { rejectionFor, steeringNoteDataSchema } from '@rocketflare/shared/ai/interrupts'
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import { type Database, pgErrorCode } from '../../../db/client'
import {
  type AgentRunDecisionRow,
  type AgentRunInterruptRow,
  type AgentRunRow,
  agentRunDecisions,
  agentRunEffects,
  agentRunEvents,
  agentRunInterrupts,
  agentRuns,
  tenants,
} from '../../../db/schema'
import { noopTracer } from '../../observability/tracer'
import type { Logger } from '../../utils/core/logger'
import { accessScopeForUser } from '../access'
import { InterruptDeclinedError, InterruptRequested, type Tool } from '../ai/agent-loop'
import { AiNotConfiguredError } from '../ai/errors'
import {
  DECISIONS_FALLBACK_PROMPT_KEY,
  resolveChat,
  resolveDecisions,
  resolveEmbeddings,
} from '../ai/resolve'
import { addUsage, type ChatClient, ZERO_USAGE } from '../ai/types'
import { type RegistryPromptKey, resolvePrompt } from '../prompts'
import { type Decision, decideWithShapes, questionsHash, toDecision } from './decisions'
import { withFanout } from './fanout'
import { approvalsForRun } from './interrupts'
import type { AgentContext, AgentEvent, AgentInterruptAnswer, AnyAgentDefinition } from './registry'
import { AgentCancelledError, errorMessage } from './runs'
import type { RuntimeEnv } from './runtime'
import { buildAgentTools } from './tools'

/** `strict`: the record or nothing. `live`: what the record cannot answer is asked for real. */
export type ReplayMode = 'strict' | 'live'

/** A call the record could not answer. */
export type ReplayMissKind = 'chat' | 'tool' | 'once' | 'decide' | 'interrupt'

export class ReplayMissError extends Error {
  constructor(
    readonly kind: ReplayMissKind,
    readonly key: string
  ) {
    super(`replay: nothing recorded for ${kind} "${key}"`)
    this.name = 'ReplayMissError'
  }
}

/** Thrown into the agent for a refused write; listed in `writes`. */
export class ReplayWriteError extends Error {
  constructor(readonly operation: string) {
    super(`replay: ${operation} refused — a replay never writes`)
    this.name = 'ReplayWriteError'
  }
}

/** How the run ended when replayed — the run statuses, plus the three only a replay can reach. */
export type ReplayStatus =
  | Extract<AgentRunStatus, 'succeeded' | 'failed' | 'cancelled'>
  | 'parked'
  | 'miss'
  | 'input_incompatible'

export interface JsonDiffEntry {
  /** `$.citations[0].title` */
  path: string
  recorded: unknown
  replayed: unknown
}

export type ReplayDecisionStatus =
  /** Same questions; the recorded answer was used. */
  | 'served'
  /** Reworded questions answered from the record (strict) — the rubric moved under the answers. */
  | 'drift'
  /**
   * Same questions about a DIFFERENT state, answered from the record (strict) — the code upstream
   * changed what the decision is about (a stricter screen kept fewer passages), so the recorded
   * answer describes inputs this replay no longer has.
   */
  | 'stale'
  /** Asked for real (live): new, reworded, or beyond the record. */
  | 'asked'
  /** Strict, and the record could not answer it. */
  | 'missing'
  /** Recorded, never asked by the code being replayed. */
  | 'unused'

export interface ReplayDecision {
  key: string
  status: ReplayDecisionStatus
  recordedHash?: string
  currentHash?: string
  /** Live only: the question ids whose answer LABEL differs from the recording. */
  changed?: string[]
}

export interface ReplayResult {
  runId: string
  agentKey: string
  recordedStatus: AgentRunStatus
  replayStatus: ReplayStatus
  /** The agent's error, when the replay failed (redacted, one line). */
  error?: string
  /** `match`: same status, same output, every decision served. `incomplete`: could not finish. */
  verdict: 'match' | 'differs' | 'incomplete'
  outputDiff: JsonDiffEntry[]
  decisions: ReplayDecision[]
  misses: { kind: ReplayMissKind; key: string }[]
  /** Writes the agent attempted and the replay refused — information, not a failure. */
  writes: string[]
  /** `once` keys a live replay ran again (`{ replay: 'rerun' }`). */
  reran: string[]
  events: AgentEvent[]
  artifacts: string[]
  /** Live only: what the calls the record could not answer cost, in tokens. */
  liveUsage?: TokenUsage
}

export interface ReplayOptions {
  /** Default `strict`: never resolves a model, never calls one. */
  mode?: ReplayMode
  logger: Logger
}

const TERMINAL: AgentRunStatus[] = ['succeeded', 'failed', 'cancelled']

/**
 * What a LIVE replay should be told before it starts. A live replay reads the tenant's knowledge
 * base as it is TODAY, through the same resolver the Worker uses — the tenant's own embeddings
 * config, then the `AI` binding, then `EMBEDDINGS_API_KEY`. Chunks do not record the model that
 * embedded them, so the only guard against a query embedded one way and searched against vectors
 * made another is resolving the SAME tier the Worker would:
 *   - nothing resolves → every `search_knowledge` answers `knowledge_search_unavailable`, and an
 *     answer that changed may have changed for that reason alone;
 *   - the Worker would use Workers AI (`workerHasAi`) but this process has no `AI` binding and fell
 *     through to the key → dense search compares two models' vectors (only the lexical half works).
 * Never throws: an unreadable tenant config is a warning too.
 */
export async function liveReplayWarnings(
  db: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  tenantId: string,
  options: { workerHasAi: boolean }
): Promise<string[]> {
  try {
    const embeddings = await resolveEmbeddings(db, cfg, env, tenantId)
    if (embeddings.source === 'platform' && !env.AI && options.workerHasAi) {
      return [
        `knowledge search embeds with ${embeddings.provider}/${embeddings.model} here, but the Worker embeds with Workers AI — dense search will compare two models' vectors; answers that depend on the knowledge base are not comparable (run \`wrangler login\` so the replay can borrow the AI binding)`,
      ]
    }
    return []
  } catch (err) {
    const why =
      err instanceof AiNotConfiguredError
        ? 'no embeddings provider is reachable from this process'
        : `the tenant's embeddings config could not be used (${errorMessage(err).slice(0, 200)})`
    return [
      `${why} — every knowledge search will answer knowledge_search_unavailable, so answers that depend on the knowledge base will differ for that reason alone`,
    ]
  }
}
/** Most output differences one result lists; a rewritten answer differs everywhere. */
export const DIFF_MAX_ENTRIES = 50

/** The settled runs of one agent in one tenant, newest first. */
export async function listReplayableRuns(
  db: Database,
  query: { tenantId: string; agentKey: AgentKey; since?: Date; limit?: number; runId?: string }
): Promise<AgentRunRow[]> {
  return db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.tenantId, query.tenantId),
        eq(agentRuns.agentKey, query.agentKey),
        inArray(agentRuns.status, TERMINAL),
        query.since ? gte(agentRuns.createdAt, query.since) : undefined,
        query.runId ? eq(agentRuns.id, query.runId) : undefined
      )
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(query.limit ?? 20)
}

/**
 * Replay one settled run with `agent` — the registry's, or a candidate with the same key. Never
 * throws for anything the agent does; throws only when the database itself fails.
 */
export async function replayRun(
  db: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  run: AgentRunRow,
  agent: AnyAgentDefinition,
  options: ReplayOptions
): Promise<ReplayResult> {
  let result: ReplayResult | undefined
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`)
      result = await replayInside(tx as unknown as Database, cfg, env, run, agent, options)
    })
  } catch (err) {
    // A raw write that reached Postgres aborts the transaction, and the COMMIT then fails; the
    // replay itself already finished and said so.
    if (!result) throw err
  }
  return result as ReplayResult
}

async function replayInside(
  tx: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  run: AgentRunRow,
  agent: AnyAgentDefinition,
  options: ReplayOptions
): Promise<ReplayResult> {
  const mode = options.mode ?? 'strict'
  const { tenantId, id: runId } = run
  const record = await loadRecord(tx, tenantId, runId)
  const misses: ReplayResult['misses'] = []
  const writes: string[] = []
  const reran: string[] = []
  const events: AgentEvent[] = []
  const artifacts = new Map<string, AgentArtifact>()
  const decisions = new Map<string, ReplayDecision>()
  let liveUsage: TokenUsage = ZERO_USAGE
  const db = refuseWrites(tx, writes)

  const base = {
    runId,
    agentKey: run.agentKey,
    recordedStatus: run.status,
    outputDiff: [],
    misses,
    writes,
    reran,
    events,
  }

  const parsedInput = agent.meta.inputSchema.safeParse(run.input)
  if (!parsedInput.success) {
    return {
      ...base,
      replayStatus: 'input_incompatible',
      error: 'The recorded input no longer parses with the current inputSchema',
      verdict: 'incomplete',
      decisions: [],
      artifacts: [],
    }
  }

  const miss = (kind: ReplayMissKind, key: string) => {
    misses.push({ kind, key })
    return new ReplayMissError(kind, key)
  }
  const tally = (usage: TokenUsage) => {
    liveUsage = addUsage(liveUsage, usage)
  }

  const tenant = await db.query.tenants.findFirst({
    columns: { name: true },
    where: eq(tenants.id, tenantId),
  })
  const live = mode === 'live' ? await liveSeams(db, cfg, env, run, agent, tally) : null
  // The real tool list either way — a strict replay keeps the names and schemas an agent looks
  // up (`ctx.tools.find(...)`), and only the handlers become misses.
  const scope = await accessScopeForUser(db, tenantId, run.requestedByUserId)
  const builtTools = await buildAgentTools({ db, cfg, env, scope })
  const tools: Tool[] = live
    ? builtTools
    : builtTools.map(tool => ({
        ...tool,
        handler: async () => {
          throw miss('tool', tool.name)
        },
      }))

  const decide = decideWithShapes(async (key, request): Promise<Decision> => {
    const parsed = decisionRequestSchema.parse(request)
    const hash = await questionsHash(parsed.questions)
    const recorded = record.decisions.get(key)
    const ids = Object.keys(parsed.questions)
    const entry: ReplayDecision = {
      key,
      status: 'served',
      currentHash: hash,
      ...(recorded && { recordedHash: recorded.questionsHash }),
    }
    decisions.set(key, entry)
    const sameState = recorded && diffJson(recorded.request.state, parsed.state, 1).length === 0
    if (recorded && recorded.questionsHash === hash && sameState) return toDecision(recorded, true)
    const answerable = recorded && ids.every(id => recorded.answers[id] !== undefined)
    if (!live) {
      if (!recorded || !answerable) {
        entry.status = 'missing'
        throw miss('decide', key)
      }
      entry.status = recorded.questionsHash === hash ? 'stale' : 'drift'
      return { ...toDecision(recorded, true), answers: pick(recorded.answers, ids) }
    }
    entry.status = 'asked'
    const answers = await live.ask(parsed)
    if (recorded) {
      entry.changed = ids.filter(id => {
        const before = recorded.answers[id]
        const after = answers.answers[id]
        return !before || !after || decisionAnswerLabel(before) !== decisionAnswerLabel(after)
      })
    }
    return {
      decisionId: `replay:${key}`,
      answers: answers.answers,
      provider: answers.provider,
      method: answers.method,
      model: answers.model,
      replayed: false,
    }
  })

  const ctx = withFanout({
    db,
    cfg,
    env,
    logger: options.logger.child({ runId, agentKey: agent.meta.key, replay: mode }),
    tracer: noopTracer,
    tenantId,
    runId,
    userId: run.requestedByUserId,
    input: parsedInput.data,
    emit: async event => {
      events.push(event)
    },
    checkCancelled: async () => {},
    chat: live?.chat ?? {
      client: missingChat(() => miss('chat', 'chat')),
      model: 'replay',
      maxOutputTokens: cfg.AGENT_MAX_OUTPUT_TOKENS,
    },
    tools,
    checkpoint: { load: async () => null, save: async () => {} },
    once: async (key, fn, onceOptions) => {
      const recorded = record.effects.get(key)
      // A `ctx.map` item: run it again, so what it asks is answered from the record and a
      // change to the item's code shows. Its own recorded result is only a cache.
      if (onceOptions?.replay === 'inner') return fn()
      if (live && onceOptions?.replay === 'rerun') {
        reran.push(key)
        return fn()
      }
      if (recorded) return recorded.result as never
      throw miss('once', key)
    },
    approvals: await approvalsForRun(db, tenantId, runId),
    interrupt: async ask =>
      answerFrom(record.interrupts.get(ask.key), () => miss('interrupt', ask.key)),
    steering: (() => {
      let delivered = false
      return async () => {
        if (delivered) return []
        delivered = true
        return record.steering
      }
    })(),
    decide,
    artifact: async input => {
      const parsed = agentArtifactInputSchema.parse(input)
      const now = new Date()
      const artifact: AgentArtifact = {
        id: `replay:${parsed.key}`,
        tenantId,
        runId,
        key: parsed.key,
        kind: parsed.data.kind,
        title: parsed.title,
        description: parsed.description ?? null,
        data: parsed.data,
        createdAt: now,
        updatedAt: now,
      }
      artifacts.set(parsed.key, artifact)
      events.push({ type: 'artifact', data: { key: parsed.key, kind: parsed.data.kind } })
      return artifact
    },
    prompt: (vars, promptKey) =>
      resolvePrompt(db, tenantId, promptKey ?? (agent.meta.promptKey as RegistryPromptKey), {
        appName: cfg.APP_NAME,
        tenantName: tenant?.name ?? '',
        ...vars,
      }),
    step: async (key, label, status, detail) => {
      events.push({ type: 'step', data: { key, label, status, ...(detail ? { detail } : {}) } })
    },
    // The agent's own client already counted live calls through `tally`, or missed in strict.
    recordUsage: async () => {},
  })

  let replayStatus: ReplayStatus
  let output: unknown = null
  let error: string | undefined
  try {
    output = agent.meta.outputSchema.parse(await agent.run(ctx))
    replayStatus = 'succeeded'
  } catch (err) {
    if (err instanceof ReplayMissError) replayStatus = 'miss'
    else if (err instanceof InterruptRequested) replayStatus = 'parked'
    else if (err instanceof InterruptDeclinedError || err instanceof AgentCancelledError) {
      replayStatus = 'cancelled'
    } else {
      // A miss the agent's own code wrapped (a tool loop turning it into an AiError) is still a miss.
      replayStatus = misses.length > 0 ? 'miss' : 'failed'
      error = errorMessage(err).slice(0, 500)
      if (isRefusedWrite(err)) error = `${error} (a write the replay refused)`
    }
  }

  for (const key of record.decisions.keys()) {
    if (!decisions.has(key)) decisions.set(key, { key, status: 'unused' })
  }
  const outputDiff = replayStatus === 'succeeded' ? diffJson(run.output, output) : []
  const decisionList = [...decisions.values()]
  return {
    ...base,
    replayStatus,
    ...(error && { error }),
    verdict: verdictOf(run.status, replayStatus, outputDiff, decisionList, misses.length),
    outputDiff,
    decisions: decisionList,
    artifacts: [...artifacts.keys()],
    ...(live && { liveUsage }),
  }
}

export function verdictOf(
  recorded: AgentRunStatus,
  replayed: ReplayStatus,
  outputDiff: JsonDiffEntry[],
  decisions: ReplayDecision[],
  misses: number
): ReplayResult['verdict'] {
  if (misses > 0 || replayed === 'parked' || replayed === 'input_incompatible') return 'incomplete'
  if (recorded !== replayed || outputDiff.length > 0) return 'differs'
  const moved = decisions.some(
    d =>
      d.status === 'drift' ||
      d.status === 'stale' ||
      d.status === 'unused' ||
      (d.changed?.length ?? 0) > 0
  )
  return moved ? 'differs' : 'match'
}

// ---- the record ------------------------------------------------------------------------------

interface RunRecord {
  decisions: Map<string, AgentRunDecisionRow>
  effects: Map<string, { result: unknown }>
  interrupts: Map<string, AgentRunInterruptRow>
  steering: Awaited<ReturnType<AgentContext['steering']>>
}

async function loadRecord(db: Database, tenantId: string, runId: string): Promise<RunRecord> {
  const [decisions, effects, interrupts, steering] = await Promise.all([
    db
      .select()
      .from(agentRunDecisions)
      .where(and(eq(agentRunDecisions.tenantId, tenantId), eq(agentRunDecisions.runId, runId))),
    db
      .select({ key: agentRunEffects.key, result: agentRunEffects.result })
      .from(agentRunEffects)
      .where(and(eq(agentRunEffects.tenantId, tenantId), eq(agentRunEffects.runId, runId))),
    db
      .select()
      .from(agentRunInterrupts)
      .where(and(eq(agentRunInterrupts.tenantId, tenantId), eq(agentRunInterrupts.runId, runId))),
    db
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.tenantId, tenantId),
          eq(agentRunEvents.runId, runId),
          eq(agentRunEvents.type, 'steering')
        )
      )
      .orderBy(asc(agentRunEvents.seq)),
  ])
  return {
    decisions: new Map(decisions.map(d => [d.key, d])),
    effects: new Map(effects.map(e => [e.key, { result: e.result }])),
    interrupts: new Map(interrupts.map(i => [i.key, i])),
    steering: steering.flatMap(row => {
      const parsed = steeringNoteDataSchema.safeParse(row.data)
      return parsed.success ? [{ ...parsed.data, eventId: row.id, at: row.at }] : []
    }),
  }
}

/** The runtime's interrupt semantics over a recorded row (`runtime.ts` `ctx.interrupt`). */
function answerFrom(
  row: AgentRunInterruptRow | undefined,
  onMiss: () => ReplayMissError
): AgentInterruptAnswer {
  if (!row || row.status === 'pending') throw onMiss()
  if (row.status === 'resolved') {
    return {
      interruptId: row.id,
      status: 'resolved',
      payload: row.payload ?? null,
      resolvedByUserId: row.resolvedByUserId,
    }
  }
  if (rejectionFor(row.spec) === 'cancel_run') {
    throw new InterruptDeclinedError(row.id, (row.payload as { note?: string } | null)?.note)
  }
  return {
    interruptId: row.id,
    status: 'cancelled',
    payload: row.payload ?? null,
    resolvedByUserId: row.resolvedByUserId,
  }
}

// ---- live seams ------------------------------------------------------------------------------

async function liveSeams(
  db: Database,
  cfg: AppConfig,
  env: RuntimeEnv,
  run: AgentRunRow,
  agent: AnyAgentDefinition,
  tally: (usage: TokenUsage) => void
) {
  const resolved = await resolveChat(db, cfg, env, run.tenantId, {
    promptKey: agent.meta.promptKey,
  })
  let engine: ReturnType<typeof resolveDecisions> | undefined
  return {
    chat: {
      client: tallied(resolved.client, tally),
      model: resolved.model,
      maxOutputTokens: resolved.maxOutputTokens,
    },
    ask: async (request: DecisionRequest) => {
      engine ??= (async () =>
        resolveDecisions(db, cfg, env, run.tenantId, {
          fallbackSystem: await resolvePrompt(db, run.tenantId, DECISIONS_FALLBACK_PROMPT_KEY, {
            appName: cfg.APP_NAME,
            tenantName: '',
          }),
        }))()
      const { client, model, provider, method } = await engine
      const result = await client.ask(request, { model })
      tally(result.usage)
      return { answers: result.answers, provider, method, model: result.model }
    },
  }
}

function tallied(client: ChatClient, tally: (usage: TokenUsage) => void): ChatClient {
  return {
    provider: client.provider,
    countTokens: client.countTokens?.bind(client),
    async complete(params) {
      const result = await client.complete(params)
      tally(result.usage)
      return result
    },
    async *stream(params) {
      for await (const delta of client.stream(params)) {
        if (delta.type === 'end') tally(delta.result.usage)
        yield delta
      }
    },
  }
}

function missingChat(onMiss: () => ReplayMissError): ChatClient {
  return {
    provider: 'anthropic_compatible',
    complete: async () => {
      throw onMiss()
    },
    // biome-ignore lint/correctness/useYield: a strict replay's stream fails before its first delta.
    async *stream() {
      throw onMiss()
    },
  }
}

// ---- no writes -------------------------------------------------------------------------------

const WRITE_METHODS = new Set(['insert', 'update', 'delete'])

/**
 * `db` with `insert`/`update`/`delete` refused before any SQL is sent — so a swallowed write
 * cannot abort the read-only transaction under everything after it. A raw `execute` write still
 * reaches Postgres, which refuses it (25006); that is the backstop, not the path.
 */
function refuseWrites(db: Database, writes: string[]): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
        return (table: unknown) => {
          const operation = `${prop} ${tableName(table)}`
          writes.push(operation)
          throw new ReplayWriteError(operation)
        }
      }
      if (prop === 'transaction') {
        return (fn: (tx: Database) => Promise<unknown>, config?: unknown) =>
          target.transaction(
            tx => fn(refuseWrites(tx as unknown as Database, writes)),
            config as never
          )
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

function tableName(table: unknown): string {
  const symbols = table && typeof table === 'object' ? Object.getOwnPropertySymbols(table) : []
  const name = symbols.find(s => s.description === 'drizzle:Name')
  return name ? String((table as Record<symbol, unknown>)[name]) : 'a table'
}

function isRefusedWrite(err: unknown): boolean {
  return err instanceof ReplayWriteError || pgErrorCode(err) === '25006'
}

// ---- diff ------------------------------------------------------------------------------------

/** Where two JSON values differ, path by path (dates compared as ISO strings), capped. */
export function diffJson(recorded: unknown, replayed: unknown, max = DIFF_MAX_ENTRIES) {
  const out: JsonDiffEntry[] = []
  walk(normalise(recorded), normalise(replayed), '$', out, max)
  return out
}

function normalise(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value ?? null))
}

function walk(a: unknown, b: unknown, path: string, out: JsonDiffEntry[], max: number): void {
  if (out.length >= max) return
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      walk(
        i < a.length ? a[i] : undefined,
        i < b.length ? b[i] : undefined,
        `${path}[${i}]`,
        out,
        max
      )
    }
    return
  }
  if (isObject(a) && isObject(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      walk(a[key], b[key], `${path}.${key}`, out, max)
    }
    return
  }
  if (a !== b) out.push({ path, recorded: a, replayed: b })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pick(answers: DecisionAnswers, ids: string[]): DecisionAnswers {
  return Object.fromEntries(ids.map(id => [id, answers[id]])) as DecisionAnswers
}
