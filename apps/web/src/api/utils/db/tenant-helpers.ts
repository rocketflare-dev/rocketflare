/**
 * Tenant creation (D9, D25) — the single place an organisation comes into existence:
 * `createTenantForUser` is transactional (tenant + membership + settings row + activity) and is
 * called by `POST /api/tenants`, `onNoTenant` (open sign-up / single-tenant bootstrap), the
 * admin `new_org` approval and the seed script. `getSingleTenant` is the `TENANCY_MODE=single`
 * anchor: the first tenant row.
 */
import type { MembershipRole } from '@gmgo/shared/tenants'
import { slugify } from '@gmgo/shared/tenants'
import { asc, eq, like } from 'drizzle-orm'
import type { Database } from '../../../db/client'
import { type Tenant, tenantSettings, tenants, tenantUsers } from '../../../db/schema'
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
  return db.transaction(async tx => {
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
}

/** `TENANCY_MODE=single`: the one tenant everybody joins — the oldest row. */
export async function getSingleTenant(db: Database): Promise<Tenant | null> {
  const [row] = await db.select().from(tenants).orderBy(asc(tenants.createdAt)).limit(1)
  return row ?? null
}
