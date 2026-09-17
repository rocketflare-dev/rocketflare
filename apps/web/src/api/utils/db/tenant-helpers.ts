/**
 * Tenant creation (D9, D25) — the single place an organisation comes into existence:
 * `createTenantForUser` is transactional (tenant + membership + settings row + activity) and is
 * called by `POST /api/tenants`, `onNoTenant` (open sign-up / single-tenant bootstrap), the
 * admin `new_org` approval and the seed script. `getSingleTenant` is the `TENANCY_MODE=single`
 * anchor: the first tenant row.
 */
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { slugify } from '@rocketflare/shared/tenants'
import { asc, eq, like } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type Tenant, tenantSettings, tenants, tenantUsers } from '../../../db/schema'
import { serverPlugins } from '../../../plugins/server'
import { recordActivity } from '../../services/activity'
import { ConflictError } from '../core/errors'
import { randomToken } from '../core/ids'

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
  invitedByUserId?: string | null
  /**
   * The features this deployment ships (D30), so the new tenant is seeded with the template
   * dashboards its environment actually has. Omitted, only unconditional templates are copied and a
   * gated feature's page arrives on the tenant's first `GET /api/analytics/pages` instead — the lazy
   * repair path that already exists, so forgetting this is late, never wrong.
   */
  features?: readonly string[]
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
    const [tenant] = await tx.insert(tenants).values({ name: input.name, slug }).returning()
    if (!tenant) throw new Error('createTenantForUser: insert returned no row')
    await tx.insert(tenantUsers).values({
      tenantId: tenant.id,
      userId: input.userId,
      role,
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
 * The kit itself contributes none since analytics became a plugin (D31): every hook is an
 * installed plugin's, each in its OWN try/catch, so one plugin's bad hook costs neither the next
 * plugin its rows nor anybody a sign-up. The contract each must keep is the one the kit's own
 * dashboards hook kept: post-commit, idempotent, and with a lazy repair path of its own (the
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
      // Best-effort, exactly like the kit's own: the plugin owns its repair path.
    }
  }
}

/** `TENANCY_MODE=single`: the one tenant everybody joins — the oldest row. */
export async function getSingleTenant(db: Database): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).orderBy(asc(tenants.createdAt)).limit(1)
  return row ?? null
}
