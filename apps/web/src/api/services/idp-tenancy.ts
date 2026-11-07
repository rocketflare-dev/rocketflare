/**
 * IdP-managed tenancy (`OIDC_MANAGED_TENANCY=true`, docs/CONCEPTS.md §2): the OIDC issuer says
 * which of its orgs the person may use THIS app in, with what role, and the app mirrors that as
 * tenants and memberships. Two ways in, one set of rules:
 *
 * - **On every sign-in** the OIDC callback runs `reconcileIdpClaims`, before `completeLogin` — it
 *   cannot live in `admitUser`, because a user who already has a provider link never reaches it.
 * - **Between sign-ins** `applyIdentityEvent` applies the issuer's signed identity events
 *   (`routes/identity-events.ts`), each doing the part of a reconcile that event describes.
 *
 * What a reconcile does, idempotently:
 * - **Tenants.** Each org in the orgs claim (`OIDC_ORGS_CLAIM`) is the tenant whose
 *   `external_org_id` is the org id. On first sight an unlinked tenant whose slug is the claim's
 *   slug is linked to the org (a tenant made in the app by hand, or before managed tenancy);
 *   otherwise one is created (named from the claim, slug from the claim's slug or name made
 *   unique). It is renamed when the claim's name changes. A tenant created here
 *   has NO owner: `owner` is an app-local decision this module never writes, so the last-owner
 *   guard only ever sees owners a person made.
 * - **Memberships.** `tenant_users` with `source = 'idp'` and the role from `OIDC_ROLE_MAP`; an org
 *   whose role is not in the map is skipped. An existing `manual` admin/member row is adopted
 *   (becomes `idp`); an `owner` or `support` row is left exactly as it is. `idp` rows are read-only
 *   in the app (409 `idp_managed`).
 * - **Removal.** An `idp` row whose tenant is not among the claims' orgs is deleted, with the
 *   member's per-tenant settings, and every session pinned to that tenant is unpinned. `manual`
 *   rows are never touched.
 * - **Global admin.** `OIDC_GLOBAL_ADMIN_CLAIM` true sets `is_global_admin` with
 *   `global_admin_source = 'idp'`; the claim going clears it, but only when the issuer granted it.
 * - **Access requests.** A person the claims give a tenant has any pending access request closed —
 *   the "waiting for an administrator" state is never right for them.
 *
 * Ordering: a sign-in stamps `idp_synced_at` on the tenants and memberships it reconciles, and an
 * event stamps its `occurredAt`. An event older than the stamp on what it would change is stale
 * (the issuer has said something newer since) and is skipped, so events apply in any order, and a
 * retried event, whose `occurredAt` equals the stamp it left, changes nothing.
 */
import {
  type IdentityEvent,
  type IdentityPersonRef,
  type IdpAppRole,
  type IdpOrgClaim,
  idpOrgsClaimSchema,
} from '@rocketflare/shared/idp'
import { and, eq, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import type { AppConfig } from '../../config'
import { type Database, isUniqueViolation } from '../../db/client'
import {
  accessRequests,
  type Tenant,
  tenants,
  tenantUserSettings,
  tenantUsers,
  type User,
  userSessions,
  users,
} from '../../db/schema'
import { findProviderLink } from '../auth/oauth-providers'
import { ConflictError } from '../utils/core/errors'
import type { Logger } from '../utils/core/logger'
import { createTenantForUser, uniqueSlug } from '../utils/db/tenant-helpers'
import { recordActivity } from './activity'
import { findUserByEmail } from './auth'

export type IdpLogger = Pick<Logger, 'info' | 'warn'>

export type IdpTenancyConfig = Pick<
  AppConfig,
  | 'OIDC_ISSUER'
  | 'OIDC_ORGS_CLAIM'
  | 'OIDC_ROLE_MAP'
  | 'OIDC_ADMIT_CLAIM'
  | 'OIDC_GLOBAL_ADMIN_CLAIM'
>

/** What a verified id_token says about the person's tenancy. */
export interface IdpClaims {
  /** The orgs whose role maps to an app role, each with that app role. */
  orgs: Array<IdpOrgClaim & { appRole: IdpAppRole }>
  /** `OIDC_ADMIT_CLAIM` is true. */
  admit: boolean
  /** `OIDC_GLOBAL_ADMIN_CLAIM` is true. */
  globalAdmin: boolean
  /**
   * When the issuer said all this: the token's `iat`, never later than now. A row an identity event
   * stamped after it keeps the event's word.
   */
  issuedAt: Date
}

/**
 * The tenancy claims of a VERIFIED id_token payload, or null — logged — when the orgs claim is
 * missing or malformed. Null means "ignore the claims": the sign-in proceeds as plain OIDC and
 * nothing is reconciled, so a broken token can never strip someone's memberships.
 */
export function readIdpClaims(
  cfg: IdpTenancyConfig,
  payload: Record<string, unknown> | undefined,
  logger: IdpLogger
): IdpClaims | null {
  const parsed = idpOrgsClaimSchema.safeParse(payload?.[cfg.OIDC_ORGS_CLAIM])
  if (!parsed.success) {
    logger.warn(
      {
        claim: cfg.OIDC_ORGS_CLAIM,
        present: payload ? cfg.OIDC_ORGS_CLAIM in payload : false,
        issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
      },
      'IdP-managed tenancy: the orgs claim is missing or malformed — ignored'
    )
    return null
  }
  const orgs: IdpClaims['orgs'] = []
  for (const org of parsed.data) {
    const appRole = cfg.OIDC_ROLE_MAP[org.role]
    if (appRole) orgs.push({ ...org, appRole })
    else logger.warn({ orgId: org.id, role: org.role }, 'IdP-managed tenancy: unmapped role')
  }
  const flag = (name: string | undefined) => Boolean(name && payload?.[name] === true)
  const iat = typeof payload?.iat === 'number' ? payload.iat * 1000 : Number.NaN
  return {
    orgs,
    admit: flag(cfg.OIDC_ADMIT_CLAIM),
    globalAdmin: flag(cfg.OIDC_GLOBAL_ADMIN_CLAIM),
    issuedAt: new Date(Number.isFinite(iat) ? Math.min(iat, Date.now()) : Date.now()),
  }
}

/** The claims admit this person: an org, the admit claim, or the global-admin claim. */
export function idpClaimsAdmit(claims: IdpClaims): boolean {
  return claims.orgs.length > 0 || claims.admit || claims.globalAdmin
}

export interface IdpReconcileResult {
  user: User
  /** The tenants the claims grant, in claim order (each now has a membership or an owner row). */
  tenantIds: string[]
  /** Tenants whose `idp` membership this reconcile removed. */
  removedTenantIds: string[]
}

/** Reconcile tenants, memberships and the global-admin flag from verified claims. */
export async function reconcileIdpClaims(
  db: Database,
  user: User,
  claims: IdpClaims,
  logger: IdpLogger,
  features: readonly string[] = []
): Promise<IdpReconcileResult> {
  const at = claims.issuedAt
  const tenantIds: string[] = []
  const seen = new Set<string>()
  for (const org of claims.orgs) {
    if (seen.has(org.id)) continue
    seen.add(org.id)
    const tenant = await ensureOrgTenant(db, user, org, features, logger, at)
    await upsertIdpMembership(db, tenant.id, user.id, org.appRole, at)
    tenantIds.push(tenant.id)
  }

  const removedTenantIds = await removeIdpMemberships(db, {
    userId: user.id,
    exceptTenantIds: tenantIds,
  })
  const updated = await reconcileGlobalAdmin(db, user, claims.globalAdmin, logger)
  if (tenantIds.length > 0) await closePendingAccessRequests(db, user.email)
  return { user: updated, tenantIds, removedTenantIds }
}

/** How many times a first sign-in tries to create an org's tenant before it gives up. */
const TENANT_CREATE_ATTEMPTS = 5

/**
 * The tenant mirroring `org`: found by `external_org_id` and renamed to the claim; else the
 * unlinked tenant whose slug is the claim's, linked to the org; else created.
 */
async function ensureOrgTenant(
  db: Database,
  user: User,
  org: IdpClaims['orgs'][number],
  features: readonly string[],
  logger: IdpLogger,
  at: Date
): Promise<Tenant> {
  for (let attempt = 1; ; attempt++) {
    const existing = await findOrgTenant(db, org.id)
    if (existing) {
      // An `org.renamed` event newer than the token keeps its name.
      const [synced] = await db
        .update(tenants)
        .set(
          existing.name === org.name
            ? { idpSyncedAt: at }
            : { name: org.name, idpSyncedAt: at, updatedAt: new Date() }
        )
        .where(
          and(
            eq(tenants.id, existing.id),
            or(isNull(tenants.idpSyncedAt), lte(tenants.idpSyncedAt, at))
          )
        )
        .returning()
      return synced ?? existing
    }
    if (org.slug && (await linkTenantBySlug(db, org.id, org.slug, logger))) continue
    try {
      return await createOrgTenant(db, user, org, features, logger, at)
    } catch (err) {
      // Another first sign-in to the same org made it (found on the next pass), or another org
      // took the same free slug (the next pass picks again).
      const clash =
        isUniqueViolation(err) || (err instanceof ConflictError && err.code === 'slug_taken')
      if (!clash || attempt >= TENANT_CREATE_ATTEMPTS) throw err
    }
  }
}

/** A new tenant for an issuer org; the founding row is the person's `idp` membership. */
async function createOrgTenant(
  db: Database,
  user: User,
  org: IdpClaims['orgs'][number],
  features: readonly string[],
  logger: IdpLogger,
  now: Date
): Promise<Tenant> {
  // Never `owner` (see the header).
  const created = await createTenantForUser(db, {
    name: org.name,
    slug: await uniqueSlug(db, org.slug ?? org.name),
    userId: user.id,
    role: org.appRole,
    source: 'idp',
    externalOrgId: org.id,
    features,
    idpSyncedAt: now,
  })
  logger.info(
    { tenantId: created.id, externalOrgId: org.id },
    'IdP-managed tenancy: created the tenant for an issuer org'
  )
  return created
}

/**
 * Link the unlinked tenant whose slug is the org's to the org (decided: the issuer's slug is
 * trusted to name the tenant made for it in the app, by hand or before managed tenancy). A tenant
 * already linked to another org is never taken. Returns whether one was linked; a concurrent
 * sign-in that linked or created the org's tenant first is found by the caller's next pass.
 */
async function linkTenantBySlug(
  db: Database,
  externalOrgId: string,
  slug: string,
  logger: IdpLogger
): Promise<boolean> {
  try {
    const [linked] = await db
      .update(tenants)
      .set({ externalOrgId, updatedAt: new Date() })
      .where(and(eq(tenants.slug, slug), isNull(tenants.externalOrgId)))
      .returning({ id: tenants.id })
    if (!linked) return false
    logger.info(
      { tenantId: linked.id, externalOrgId, slug },
      'IdP-managed tenancy: linked the existing tenant with the org slug'
    )
    return true
  } catch (err) {
    if (isUniqueViolation(err)) return true
    throw err
  }
}

async function findOrgTenant(db: Database, externalOrgId: string): Promise<Tenant | undefined> {
  return db.query.tenants.findFirst({ where: eq(tenants.externalOrgId, externalOrgId) })
}

/**
 * Insert or update the `idp` row; an `owner` or `support` row is the app's and stays as is. Each
 * write applies only to the row as read and never over an event newer than the token, so an owner
 * promotion or an identity event in between wins; a row removed in between is inserted again,
 * since the claims grant it.
 */
async function upsertIdpMembership(
  db: Database,
  tenantId: string,
  userId: string,
  role: IdpAppRole,
  at: Date
): Promise<void> {
  const row = and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId))
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await db.query.tenantUsers.findFirst({ where: row })
    if (!current) {
      const [inserted] = await db
        .insert(tenantUsers)
        .values({ tenantId, userId, role, source: 'idp', idpSyncedAt: at })
        .onConflictDoNothing()
        .returning({ userId: tenantUsers.userId })
      if (!inserted) continue
      await recordActivity(db, {
        tenantId,
        userId,
        type: 'member.joined',
        subjectType: 'TenantMember',
        subjectId: userId,
        metadata: { via: 'idp', role },
      })
      return
    }
    if (current.role === 'owner' || current.role === 'support') return
    const [updated] = await db
      .update(tenantUsers)
      .set({ role, source: 'idp', idpSyncedAt: at })
      .where(
        and(
          row,
          eq(tenantUsers.role, current.role),
          eq(tenantUsers.source, current.source),
          or(isNull(tenantUsers.idpSyncedAt), lte(tenantUsers.idpSyncedAt, at))
        )
      )
      .returning({ userId: tenantUsers.userId })
    if (updated) {
      if (current.role !== role) {
        await recordActivity(db, {
          tenantId,
          userId,
          type: 'member.role_changed',
          subjectType: 'TenantMember',
          subjectId: userId,
          metadata: { from: current.role, to: role, via: 'idp' },
        })
      }
      return
    }
    // Not updated: changed since the read (it stays) or removed since (insert it on the next pass).
    if (await db.query.tenantUsers.findFirst({ where: row })) return
  }
}

/** The row has not heard from the issuer since `at` (or `at` is absent: a sign-in decides). */
function staleBefore(at: Date | undefined) {
  return at ? or(isNull(tenantUsers.idpSyncedAt), lt(tenantUsers.idpSyncedAt, at)) : undefined
}

/**
 * Delete `idp` rows matching the filter, with the member's per-tenant settings, and unpin the
 * sessions pinned to those tenants. `before` (an event's `occurredAt`) spares rows a later sign-in
 * or event has stamped. Returns the tenant of each row removed.
 */
async function removeIdpMemberships(
  db: Database,
  filter: { userId?: string; tenantId?: string; exceptTenantIds?: string[]; before?: Date }
): Promise<string[]> {
  const stale = await db
    .select({ tenantId: tenantUsers.tenantId, userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.source, 'idp'),
        filter.userId ? eq(tenantUsers.userId, filter.userId) : undefined,
        filter.tenantId ? eq(tenantUsers.tenantId, filter.tenantId) : undefined,
        filter.exceptTenantIds?.length
          ? notInArray(tenantUsers.tenantId, filter.exceptTenantIds)
          : undefined,
        staleBefore(filter.before)
      )
    )
  if (stale.length === 0) return []
  const removed: typeof stale = []
  await db.transaction(async tx => {
    for (const { tenantId, userId } of stale) {
      const row = and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId))
      // The staleness check again: a sign-in or event that stamped the row since the read wins.
      const [gone] = await tx
        .delete(tenantUsers)
        .where(and(row, eq(tenantUsers.source, 'idp'), staleBefore(filter.before)))
        .returning({ userId: tenantUsers.userId })
      if (!gone) continue
      removed.push({ tenantId, userId })
      await tx
        .delete(tenantUserSettings)
        .where(
          and(eq(tenantUserSettings.tenantId, tenantId), eq(tenantUserSettings.userId, userId))
        )
      // A session pinned to a tenant the person just lost falls back to another membership.
      await tx
        .update(userSessions)
        .set({ selectedTenantId: null })
        .where(and(eq(userSessions.userId, userId), eq(userSessions.selectedTenantId, tenantId)))
    }
  })
  for (const { tenantId, userId } of removed) {
    await recordActivity(db, {
      tenantId,
      userId,
      type: 'member.removed',
      subjectType: 'TenantMember',
      subjectId: userId,
      metadata: { via: 'idp' },
    })
  }
  return removed.map(r => r.tenantId)
}

/** Grant from the claim; revoke only what the claim granted. */
async function reconcileGlobalAdmin(
  db: Database,
  user: User,
  globalAdmin: boolean,
  logger: IdpLogger
): Promise<User> {
  let patch: Partial<Pick<User, 'isGlobalAdmin' | 'globalAdminSource'>> | null = null
  if (globalAdmin && !user.isGlobalAdmin) {
    patch = { isGlobalAdmin: true, globalAdminSource: 'idp' }
    logger.warn({ userId: user.id }, 'IdP-managed tenancy: the global-admin claim → GLOBAL ADMIN')
  } else if (!globalAdmin && user.isGlobalAdmin && user.globalAdminSource === 'idp') {
    patch = { isGlobalAdmin: false, globalAdminSource: null }
    logger.warn(
      { userId: user.id },
      'IdP-managed tenancy: the global-admin claim is gone → not global admin'
    )
  }
  if (!patch) return user
  const [updated] = await db.update(users).set(patch).where(eq(users.id, user.id)).returning()
  return updated ?? { ...user, ...patch }
}

/** A person the claims seat in a tenant is not waiting for anyone. */
async function closePendingAccessRequests(db: Database, email: string): Promise<void> {
  await db
    .update(accessRequests)
    .set({ status: 'approved', decidedAt: new Date() })
    .where(
      and(
        sql`lower(${accessRequests.email}) = ${email.toLowerCase()}`,
        eq(accessRequests.status, 'pending')
      )
    )
}

// ---- Identity events ----------------------------------------------------------------------

/** How far the issuer's clock and this database's may disagree when ending sessions. */
const CLOCK_SKEW_MS = 60_000

/** What applying one event did, for the log line. */
export type IdentityEventOutcome = 'applied' | 'stale' | 'unknown_person' | 'unknown_org'

/**
 * The user an event's person ref names: the OIDC provider link by `sub` (stored as
 * `<issuer>|<sub>`, `auth/providers/oidc.ts`), else the email.
 */
async function findPerson(
  db: Database,
  cfg: IdpTenancyConfig,
  person: IdentityPersonRef
): Promise<User | undefined> {
  if (person.sub && cfg.OIDC_ISSUER) {
    const link = await findProviderLink(db, 'oidc', `${cfg.OIDC_ISSUER}|${person.sub}`)
    if (link) return db.query.users.findFirst({ where: eq(users.id, link.userId) })
  }
  return findUserByEmail(db, person.email)
}

/**
 * Apply one verified identity event. Each does what the next sign-in's reconcile would, for the
 * part of the person's tenancy it describes; nothing it does outlasts a sign-in that says
 * otherwise. Records the event nowhere: `idp_synced_at` makes a repeat a no-op.
 */
export async function applyIdentityEvent(
  db: Database,
  cfg: IdpTenancyConfig,
  event: IdentityEvent
): Promise<IdentityEventOutcome> {
  const at = new Date(event.occurredAt)
  switch (event.type) {
    case 'person.suspended': {
      const user = await findPerson(db, cfg, event.data)
      if (!user) return 'unknown_person'
      // A session started well after the suspension came from a sign-in the issuer allowed again;
      // CLOCK_SKEW_MS covers the issuer's clock and this database's disagreeing.
      const cutoff = new Date(at.getTime() + CLOCK_SKEW_MS)
      const ended = await db
        .delete(userSessions)
        .where(and(eq(userSessions.userId, user.id), lt(userSessions.createdAt, cutoff)))
        .returning({ id: userSessions.id })
      const removed = await removeIdpMemberships(db, { userId: user.id, before: at })
      return ended.length + removed.length > 0 ? 'applied' : 'stale'
    }
    case 'membership.removed': {
      const [user, tenant] = await Promise.all([
        findPerson(db, cfg, event.data),
        findOrgTenant(db, event.data.orgId),
      ])
      if (!user) return 'unknown_person'
      if (!tenant) return 'unknown_org'
      const removed = await removeIdpMemberships(db, {
        userId: user.id,
        tenantId: tenant.id,
        before: at,
      })
      return removed.length > 0 ? 'applied' : 'stale'
    }
    case 'membership.role_changed': {
      const [user, tenant] = await Promise.all([
        findPerson(db, cfg, event.data),
        findOrgTenant(db, event.data.orgId),
      ])
      if (!user) return 'unknown_person'
      if (!tenant) return 'unknown_org'
      const role = cfg.OIDC_ROLE_MAP[event.data.role]
      // A role the map doesn't know is an org the next sign-in would skip.
      if (!role) {
        const removed = await removeIdpMemberships(db, {
          userId: user.id,
          tenantId: tenant.id,
          before: at,
        })
        return removed.length > 0 ? 'applied' : 'stale'
      }
      // Changes a membership that exists; the sign-in that grants the org creates it.
      const [before] = await db
        .select({ role: tenantUsers.role })
        .from(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, tenant.id),
            eq(tenantUsers.userId, user.id),
            eq(tenantUsers.source, 'idp'),
            staleBefore(at)
          )
        )
      if (!before) return 'stale'
      await db
        .update(tenantUsers)
        .set({ role, idpSyncedAt: at })
        .where(
          and(
            eq(tenantUsers.tenantId, tenant.id),
            eq(tenantUsers.userId, user.id),
            eq(tenantUsers.source, 'idp'),
            staleBefore(at)
          )
        )
      if (before.role !== role) {
        await recordActivity(db, {
          tenantId: tenant.id,
          userId: user.id,
          type: 'member.role_changed',
          subjectType: 'TenantMember',
          subjectId: user.id,
          metadata: { from: before.role, to: role, via: 'idp' },
        })
      }
      return 'applied'
    }
    case 'grant.revoked':
    case 'org.suspended': {
      const tenant = await findOrgTenant(db, event.data.orgId)
      if (!tenant) return 'unknown_org'
      const person = event.type === 'grant.revoked' ? event.data.person : undefined
      const user = person ? await findPerson(db, cfg, person) : undefined
      if (person && !user) return 'unknown_person'
      const removed = await removeIdpMemberships(db, {
        tenantId: tenant.id,
        userId: user?.id,
        before: at,
      })
      return removed.length > 0 ? 'applied' : 'stale'
    }
    case 'org.renamed': {
      const tenant = await findOrgTenant(db, event.data.orgId)
      if (!tenant) return 'unknown_org'
      const renamed = await db
        .update(tenants)
        .set({ name: event.data.name, idpSyncedAt: at, updatedAt: new Date() })
        .where(
          and(
            eq(tenants.id, tenant.id),
            or(isNull(tenants.idpSyncedAt), lt(tenants.idpSyncedAt, at))
          )
        )
        .returning({ id: tenants.id })
      return renamed.length > 0 ? 'applied' : 'stale'
    }
  }
}
