/**
 * `GET /api/home/summary`: every part of the signed-in Home in one request. Each part answers
 * `null` when the reader may not see it, and each mirrors the rule of the endpoint that owns the
 * same data — members through `read TenantMember`, invitations through `read Invitation`, the
 * activity log admin-level only (as `GET /api/activity`), spend admin-level and only against a
 * configured daily budget.
 *
 * `FEATURE_PARTS` is a registry: an optional feature contributes its part here (one line each),
 * and a copy that deletes the feature deletes its line. Core parts are below it.
 */
import { MICROCENTS_PER_USD } from '@rocketflare/shared/ai/pricing'
import { KNOWLEDGE_USAGE_FEATURES } from '@rocketflare/shared/ai/usage'
import {
  HOME_SPEND_DAYS,
  type HomeSpendLine,
  type HomeSpendScope,
  type HomeSummary,
  type HomeTeam,
  lastUtcDays,
} from '@rocketflare/shared/home'
import type { TenantRole } from '@rocketflare/shared/tenants'
import { and, asc, desc, eq, gte, inArray, isNotNull, type SQL, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { activityEvents, aiUsage, tenantUsers, users } from '../../db/schema'
import { isAdminLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import { homeAgents } from './agents/home'
import { homeKnowledge } from './ai/home-knowledge'
import { readiness } from './ai/resolve'
import type { AiEnv } from './ai/types'
import { listInvitations } from './invitations'

type TenantAuth = AuthContext & { tenantId: string }

export interface HomeContext {
  db: Database
  cfg: AppConfig
  env: AiEnv
  auth: TenantAuth
  now?: Date
}

/** The optional features' parts, one line per feature. */
const FEATURE_PARTS = {
  agents: (ctx: HomeContext) => homeAgents(ctx.db, ctx.auth, ctx.now),
  knowledge: (ctx: HomeContext) => homeKnowledge(ctx.db, ctx.auth),
} satisfies Partial<Record<keyof HomeSummary, (ctx: HomeContext) => Promise<unknown>>>

/** How many faces the team part carries. */
export const HOME_TEAM_FACES = 6
/** How many activity items Home shows. */
export const HOME_ACTIVITY_ITEMS = 8

export async function homeSummary(ctx: HomeContext): Promise<HomeSummary> {
  const [chat, team, spend, activity, features] = await Promise.all([
    homeChat(ctx),
    homeTeam(ctx),
    homeSpend(ctx),
    homeActivity(ctx),
    Promise.all(
      Object.entries(FEATURE_PARTS).map(async ([part, load]) => [part, await load(ctx)] as const)
    ),
  ])
  // A part whose feature is not installed has no line above, so it answers null.
  const parts = Object.fromEntries(features) as Partial<
    Pick<HomeSummary, keyof typeof FEATURE_PARTS>
  >
  return {
    chat,
    agents: parts.agents ?? null,
    knowledge: parts.knowledge ?? null,
    team,
    spend,
    activity,
  }
}

async function homeChat({ db, cfg, env, auth }: HomeContext): Promise<HomeSummary['chat']> {
  if (!auth.ability.can('read', 'Conversation')) return null
  const ready = await readiness(db, cfg, env, auth.tenantId)
  return { ready: ready.chat.ready }
}

async function homeTeam({ db, auth }: HomeContext): Promise<HomeTeam | null> {
  if (!auth.ability.can('read', 'TenantMember')) return null
  const inTenant = eq(tenantUsers.tenantId, auth.tenantId)
  const [faces, byRole, invitations] = await Promise.all([
    db
      .select({
        userId: tenantUsers.userId,
        name: users.name,
        avatarUrl: users.avatarUrl,
        role: tenantUsers.role,
      })
      .from(tenantUsers)
      .innerJoin(users, eq(users.id, tenantUsers.userId))
      .where(and(inTenant, inArray(tenantUsers.role, ['owner', 'admin', 'member'])))
      .orderBy(asc(tenantUsers.joinedAt))
      .limit(HOME_TEAM_FACES),
    db
      .select({ role: tenantUsers.role, n: sql<number>`count(*)::int` })
      .from(tenantUsers)
      .where(inTenant)
      .groupBy(tenantUsers.role),
    auth.ability.can('read', 'Invitation')
      ? listInvitations(db, auth.tenantId, { page: 1, pageSize: 3 })
      : null,
  ])
  const roles: Record<TenantRole, number> = { owner: 0, admin: 0, member: 0 }
  for (const row of byRole) {
    // A visiting support person is not one of the team.
    if (row.role in roles) roles[row.role as TenantRole] = Number(row.n)
  }
  return {
    members: faces.map(f => ({ ...f, role: f.role as TenantRole })),
    total: roles.owner + roles.admin + roles.member,
    roles,
    invitations: invitations
      ? {
          total: invitations.total,
          recent: invitations.items.map(i => ({
            id: i.id,
            email: i.email,
            createdAt: i.createdAt,
          })),
        }
      : null,
  }
}

const KNOWLEDGE_FEATURE_NAMES = Object.values(KNOWLEDGE_USAGE_FEATURES)

/** What each budget counts: the agents' rows carry a run id, the knowledge base's a feature name. */
const SPEND_SCOPES: Record<
  HomeSpendScope,
  { budget: (cfg: AppConfig) => number | undefined; where: SQL }
> = {
  agents: { budget: cfg => cfg.AGENT_TENANT_DAILY_COST_USD, where: isNotNull(aiUsage.agentRunId) },
  knowledge: {
    budget: cfg => cfg.KNOWLEDGE_TENANT_DAILY_COST_USD,
    where: inArray(aiUsage.feature, KNOWLEDGE_FEATURE_NAMES),
  },
}

async function homeSpend({ db, cfg, auth, now }: HomeContext): Promise<HomeSummary['spend']> {
  if (!isAdminLevel(auth)) return null
  const scopes = (Object.keys(SPEND_SCOPES) as HomeSpendScope[]).filter(
    s => SPEND_SCOPES[s].budget(cfg) !== undefined
  )
  if (scopes.length === 0) return null
  const keys = lastUtcDays(HOME_SPEND_DAYS, now)
  const since = new Date(`${keys[0]}T00:00:00.000Z`)
  const day = sql<string>`to_char(${aiUsage.at} at time zone 'UTC', 'YYYY-MM-DD')`
  const lines = await Promise.all(
    scopes.map(async (scope): Promise<HomeSpendLine> => {
      const rows = await db
        .select({ day, cost: sql<number>`coalesce(sum(${aiUsage.costMicrocents}), 0)::bigint` })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.tenantId, auth.tenantId),
            gte(aiUsage.at, since),
            SPEND_SCOPES[scope].where
          )
        )
        .groupBy(day)
      const byDay = new Map(rows.map(r => [r.day, Number(r.cost) / MICROCENTS_PER_USD]))
      const days = keys.map(date => ({ date, costUsd: byDay.get(date) ?? 0 }))
      return {
        scope,
        dailyBudgetUsd: SPEND_SCOPES[scope].budget(cfg) ?? 0,
        todayUsd: days.at(-1)?.costUsd ?? 0,
        days,
      }
    })
  )
  return { lines }
}

async function homeActivity({ db, auth }: HomeContext): Promise<HomeSummary['activity']> {
  if (!isAdminLevel(auth)) return null
  const rows = await db
    .select({
      event: activityEvents,
      actorName: users.name,
      actorEmail: users.email,
      memberRole: tenantUsers.role,
    })
    .from(activityEvents)
    .leftJoin(users, eq(users.id, activityEvents.userId))
    .leftJoin(
      tenantUsers,
      and(eq(tenantUsers.tenantId, activityEvents.tenantId), eq(tenantUsers.userId, users.id))
    )
    .where(eq(activityEvents.tenantId, auth.tenantId))
    .orderBy(desc(activityEvents.createdAt))
    .limit(HOME_ACTIVITY_ITEMS)
  // Named only when the actor is one of the team: a global admin or support acting from outside
  // (or someone since removed) reads as the thing that happened, not as an unfamiliar name.
  return rows.map(r => ({
    ...r.event,
    actor:
      r.actorName && r.actorEmail && r.memberRole && r.memberRole !== 'support'
        ? { name: r.actorName, email: r.actorEmail }
        : null,
  }))
}
