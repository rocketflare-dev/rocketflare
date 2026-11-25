/**
 * `GET /api/home/summary` — everything the signed-in Home shows, in one request. Each part is the
 * work area it feeds (the composer, agent runs, knowledge, the team, AI spend, activity), and each
 * is `null` when the reader may not see it or the feature behind it is not installed, so the UI
 * renders an area only when its part is present.
 *
 * The feature parts (`agents`, `knowledge`) carry statuses as plain strings on purpose: this
 * module is core, and it must still compile in a copy that deleted those features (whose own
 * contracts go with them). Their sections narrow the strings with the feature's own schema.
 */
import { z } from 'zod'
import { activityEventSchema } from './activity'
import { tenantRoleSchema } from './tenants'

/** The window the runs chart covers, in UTC days, today included. */
export const HOME_RUN_DAYS = 14
/** The window the spend line covers, in UTC days, today included. */
export const HOME_SPEND_DAYS = 14

/** `YYYY-MM-DD` in UTC. */
const dayKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const homeChatSchema = z.object({
  /** A chat model resolves for this organisation (its own, or the platform's). */
  ready: z.boolean(),
})

/** One UTC day of top-level runs, by outcome. `active` = queued, running or waiting on someone. */
export const homeRunDaySchema = z.object({
  date: dayKeySchema,
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
})
export type HomeRunDay = z.infer<typeof homeRunDaySchema>

export const homeRunSchema = z.object({
  id: z.string().uuid(),
  agentKey: z.string(),
  /** The agent's title from the registry; the key when this deployment no longer has it. */
  agentTitle: z.string(),
  /** What the run was about, read from its input ("Supply-chain risk in Q4"); `null` if nothing reads. */
  subject: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  /** Who started it; `null` for a run started by the system or an event, or a removed person. */
  requestedBy: z.object({ name: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  createdAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  /** Model tokens the run used, from the usage ledger; `null` when it recorded none. */
  tokens: z.number().int().nonnegative().nullable(),
  /** Its estimated cost in USD; `null` when no price is known. */
  costUsd: z.number().nonnegative().nullable(),
})
export type HomeRun = z.infer<typeof homeRunSchema>

/** One agent's fortnight: how often, how it went, when last. */
export const homeAgentLineSchema = z.object({
  agentKey: z.string(),
  agentTitle: z.string(),
  runs: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  lastRunAt: z.coerce.date(),
  /** Runs per UTC day, oldest first, `HOME_RUN_DAYS` entries. */
  daily: z.array(z.number().int().nonnegative()),
})
export type HomeAgentLine = z.infer<typeof homeAgentLineSchema>

export const homeAgentsSchema = z.object({
  /** Oldest first, exactly `HOME_RUN_DAYS` entries, zero days included. */
  days: z.array(homeRunDaySchema),
  /** The newest top-level runs the reader may open. */
  recent: z.array(homeRunSchema),
  /** The `HOME_RUN_DAYS` before `days`, totalled: what the fortnight is compared with. */
  previous: z.object({
    runs: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
  }),
  /** Each agent run in the window, busiest first. */
  byAgent: z.array(homeAgentLineSchema),
})
export type HomeAgents = z.infer<typeof homeAgentsSchema>

const SUBJECT_MAX = 80

/**
 * What a run was about, from its input: the first non-empty string value, its first line without
 * Markdown heading marks, shortened at a word. Pure; `null` when the input has no text in it.
 */
export function runSubject(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    const line = value
      .split(/\n/)
      .map(l => l.replace(/^#+\s*/, '').trim())
      .find(Boolean)
    if (!line) continue
    if (line.length <= SUBJECT_MAX) return line
    const cut = line.slice(0, SUBJECT_MAX - 1)
    const space = cut.lastIndexOf(' ')
    return `${(space > SUBJECT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  return null
}

export const homeDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  chunkCount: z.number().int().nonnegative(),
  /** Facts extracted from it; `null` when knowledge facts are off for this organisation. */
  factCount: z.number().int().nonnegative().nullable(),
  createdAt: z.coerce.date(),
})
export type HomeDocument = z.infer<typeof homeDocumentSchema>

export const homeKnowledgeSchema = z.object({
  /** The newest documents the reader may open. */
  recent: z.array(homeDocumentSchema),
  /** Every document the reader may open. */
  total: z.number().int().nonnegative(),
  /** Of those, still being converted or indexed. */
  pending: z.number().int().nonnegative(),
})
export type HomeKnowledge = z.infer<typeof homeKnowledgeSchema>

export const homeMemberSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  role: tenantRoleSchema,
})
export type HomeMember = z.infer<typeof homeMemberSchema>

export const homeInvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  createdAt: z.coerce.date(),
})

export const homeTeamSchema = z.object({
  /** The people who joined first, up to a handful — the faces, not the directory. */
  members: z.array(homeMemberSchema),
  total: z.number().int().nonnegative(),
  roles: z.object({
    owner: z.number().int().nonnegative(),
    admin: z.number().int().nonnegative(),
    member: z.number().int().nonnegative(),
  }),
  /**
   * Support memberships (a platform admin visiting to help): listed in Settings → People, but
   * not part of `total` — the team card names them apart so the two counts reconcile.
   */
  support: z.number().int().nonnegative().default(0),
  /** Pending invitations; `null` when the reader may not read them. */
  invitations: z
    .object({
      total: z.number().int().nonnegative(),
      recent: z.array(homeInvitationSchema),
    })
    .nullable(),
})
export type HomeTeam = z.infer<typeof homeTeamSchema>

export const homeSpendScopeSchema = z.enum(['agents', 'knowledge'])
export type HomeSpendScope = z.infer<typeof homeSpendScopeSchema>

/** One budget this deployment sets, with what was spent against it per UTC day. */
export const homeSpendLineSchema = z.object({
  scope: homeSpendScopeSchema,
  dailyBudgetUsd: z.number().nonnegative(),
  todayUsd: z.number().nonnegative(),
  /** Oldest first, exactly `HOME_SPEND_DAYS` entries, today last. */
  days: z.array(z.object({ date: dayKeySchema, costUsd: z.number().nonnegative() })),
})
export type HomeSpendLine = z.infer<typeof homeSpendLineSchema>

export const homeSummarySchema = z.object({
  chat: homeChatSchema.nullable(),
  agents: homeAgentsSchema.nullable(),
  knowledge: homeKnowledgeSchema.nullable(),
  team: homeTeamSchema.nullable(),
  /** Admin-level only, and only when a daily budget is set — otherwise there is nothing to measure. */
  spend: z.object({ lines: z.array(homeSpendLineSchema).min(1) }).nullable(),
  /** Admin-level only (the activity log's own rule). Newest first. */
  activity: z.array(activityEventSchema).nullable(),
})
export type HomeSummary = z.infer<typeof homeSummarySchema>

/** `YYYY-MM-DD` of the UTC day `at` falls in. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** The last `days` UTC day keys ending with the one `now` falls in, oldest first. */
export function lastUtcDays(days: number, now: Date = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: days }, (_, i) =>
    utcDayKey(new Date(today - (days - 1 - i) * 86_400_000))
  )
}
