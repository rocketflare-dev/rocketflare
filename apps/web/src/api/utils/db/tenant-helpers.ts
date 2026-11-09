/**
 * Tenant creation — the single place an organisation comes into existence:
 * `createTenantForUser` is transactional (tenant + membership + settings row + activity) and is
 * called by `POST /api/tenants`, `onNoTenant` (open sign-up / single-tenant bootstrap), the
 * admin `new_org` approval and the seed script. `getSingleTenant` is the `TENANCY_MODE=single`
 * anchor: the first tenant row. `resolveOwnerTenant` picks the tenant that owns content served
 * without a signed-in member, in either tenancy mode.
 */
import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { MembershipRole, MembershipSource } from '@rocketflare/shared/tenants'
import { slugify } from '@rocketflare/shared/tenants'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { type Tenant, tenantSettings, tenants, tenantUsers, users } from '../../../db/schema'
import { type AnyServerPlugin, serverPlugins } from '../../../plugins/server'
import { recordActivity } from '../../services/activity'
import type { AppBindings } from '../../types'
import { ConflictError, ForbiddenError } from '../core/errors'
import { randomToken } from '../core/ids'
import type { Logger } from '../core/logger'
import { asCount } from '../routes/pagination'

/** `slugify(name)`, with `-2`, `-3`… appended while the slug is taken. */
export async function uniqueSlug(db: Database, base: string, fallback = 'org'): Promise<string> {
  const root = slugify(base, fallback)
  const taken = new Set(
    (
      await db
        .select({ slug: tenants.slug })
        .from(tenants)
        .where(like(tenants.slug, `${root}%`))
    ).map(r => r.slug)
  )
  if (!taken.has(root)) return root
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`.slice(0, 63)
    if (!taken.has(candidate)) return candidate
  }
  return `${root}-${randomToken(4)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`
}

export interface CreateTenantForUserInput {
  name: string
  /** Explicit slug (must be free → 409 `slug_taken`), else derived from `name`. */
  slug?: string
  userId: string
  role?: MembershipRole
  /** The founding membership's source (`manual` unless IdP-managed tenancy creates the tenant). */
  source?: MembershipSource
  /** The issuer's org id (`tenants.external_org_id`, IdP-managed tenancy). */
  externalOrgId?: string | null
  /** When the issuer last spoke about the tenant and this membership (`idp_synced_at`). */
  idpSyncedAt?: Date | null
  invitedByUserId?: string | null
  /**
   * The features this deployment ships, so the new tenant is seeded with the template
   * dashboards its environment actually has. Omitted, only unconditional templates are copied and a
   * gated feature's page arrives on the tenant's first `GET /api/analytics/pages` instead — the lazy
   * repair path that already exists, so forgetting this is late, never wrong.
   */
  features?: readonly string[]
  /**
   * The ceiling on organisations `userId` may own; the new one is refused with 403
   * `tenant_limit_reached` at it. Counted under a lock on the user row, so simultaneous creations
   * cannot pass it. Omitted, there is no ceiling (sign-up, the admin paths, IdP-managed tenancy).
   */
  maxOwnedTenants?: number
}

export async function createTenantForUser(
  db: Database,
  input: CreateTenantForUserInput
): Promise<Tenant> {
  const slug = input.slug ?? (await uniqueSlug(db, input.name))
  if (input.slug) {
    const clash = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) })
    if (clash) throw new ConflictError('That slug is already taken', 'slug_taken')
  }
  const role = input.role ?? 'owner'
  const tenant = await db.transaction(async tx => {
    if (input.maxOwnedTenants !== undefined) {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update')
      const [owned] = await tx
        .select({ count: sql`count(*)` })
        .from(tenantUsers)
        .where(and(eq(tenantUsers.userId, input.userId), eq(tenantUsers.role, 'owner')))
      if (asCount(owned?.count) >= input.maxOwnedTenants) {
        throw new ForbiddenError(
          'You have reached the limit of organisations you can own',
          ERROR_CODES.tenantLimitReached
        )
      }
    }
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: input.name,
        slug,
        externalOrgId: input.externalOrgId ?? null,
        idpSyncedAt: input.idpSyncedAt ?? null,
      })
      .returning()
    if (!tenant) throw new Error('createTenantForUser: insert returned no row')
    await tx.insert(tenantUsers).values({
      tenantId: tenant.id,
      userId: input.userId,
      role,
      source: input.source ?? 'manual',
      idpSyncedAt: input.idpSyncedAt ?? null,
      invitedByUserId: input.invitedByUserId ?? null,
    })
    await tx.insert(tenantSettings).values({ tenantId: tenant.id }).onConflictDoNothing()
    await recordActivity(tx as unknown as Database, {
      tenantId: tenant.id,
      userId: input.userId,
      type: 'tenant.created',
      subjectType: 'Tenant',
      subjectId: tenant.id,
      metadata: { name: tenant.name, slug: tenant.slug },
    })
    return tenant
  })
  await onTenantCreated(db, tenant, input.userId, input.features ?? [])
  return tenant
}

/**
 * Post-commit hooks for a new organisation. Best-effort and OUTSIDE the transaction — nothing here
 * may break sign-up or invite accept.
 *
 * Core contributes none: every hook is an
 * installed plugin's, each in its OWN try/catch, so one plugin's bad hook costs neither the next
 * plugin its rows nor anybody a sign-up. The contract each must keep:
 * post-commit, idempotent, and with a lazy repair path of its own (the
 * analytics plugin's is `ensureDefaultDashboards` on every `GET /api/analytics/pages`), because a
 * swallowed failure here is a tenant that quietly starts life half-seeded.
 */
async function onTenantCreated(
  db: Database,
  tenant: Tenant,
  userId: string,
  features: readonly string[]
): Promise<void> {
  for (const plugin of serverPlugins) {
    try {
      await plugin.hooks?.onTenantCreated?.(db, tenant, userId, features)
    } catch {
      // Best-effort: the plugin owns its repair path.
    }
  }
}

/**
 * Post-delete hooks for an organisation that is gone (`tenant.purge`). The mirror of
 * `onTenantCreated` and the same contract — best-effort, idempotent, each plugin in its own
 * try/catch — with one difference that matters: this runs from a QUEUE consumer, so a failure here
 * is logged rather than swallowed silently, and the job still acks. A plugin whose hook throws must
 * not make the purge retry for ever, because every retry re-runs core's own deletion too.
 *
 * `plugins` is injectable so the hook contract can be tested against fixtures rather than against
 * whatever happens to be installed.
 */
export async function runTenantDeletedHooks(
  db: Database,
  tenantId: string,
  env: AppBindings,
  logger?: Logger,
  plugins: readonly AnyServerPlugin[] = serverPlugins
): Promise<void> {
  for (const plugin of plugins) {
    try {
      await plugin.hooks?.onTenantDeleted?.(db, tenantId, env)
    } catch (err) {
      logger?.warn(
        { err, tenantId, plugin: plugin.shared.id },
        'tenant.purge: plugin onTenantDeleted hook failed'
      )
    }
  }
}

/** `TENANCY_MODE=single`: the one tenant everybody joins — the oldest row. */
export async function getSingleTenant(db: Database): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).orderBy(asc(tenants.createdAt)).limit(1)
  return row ?? null
}

/**
 * The tenant that owns a public surface: the one tenant under `single`, the tenant named by
 * `ownerSlug` under `multi`. Null when there is none, or when it is not `active`, so a suspended
 * tenant's content stops being served in both modes.
 */
export async function resolveOwnerTenant(
  db: Database,
  config: Pick<AppConfig, 'TENANCY_MODE'>,
  ownerSlug?: string
): Promise<Tenant | null> {
  const tenant = await findOwnerTenant(db, config, ownerSlug)
  return tenant?.status === 'active' ? tenant : null
}

async function findOwnerTenant(
  db: Database,
  config: Pick<AppConfig, 'TENANCY_MODE'>,
  ownerSlug?: string
): Promise<Tenant | null> {
  if (config.TENANCY_MODE === 'single') return getSingleTenant(db)
  if (!ownerSlug) return null
  const [row] = await db.select().from(tenants).where(eq(tenants.slug, ownerSlug)).limit(1)
  return row ?? null
}
