/**
 * Development seed (D9, D25) — idempotent, run as `pnpm seed` (loads .dev.vars). Multi-tenant:
 * tenant `Acme` (`acme`) with owner/admin/member `*@example.test` (verified), a pending invitation
 * for `invited@example.test`, one API key printed ONCE (only its hash is stored) and a global
 * admin `admin@gmgo.local`. `TENANCY_MODE=single`: the single tenant is named after `APP_NAME`
 * with slug `default` instead. Node-only script; the Worker never imports it.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'
import { mintApiKey } from '../src/api/auth/api-keys'
import { hashToken } from '../src/api/utils/core/hash'
import { randomToken } from '../src/api/utils/core/ids'
import { createTenantForUser, getSingleTenant } from '../src/api/utils/db/tenant-helpers'
import { closeAllDatabases, type Database, getScriptDatabase } from '../src/db/client'
import { apiKeys, teamInvitations, tenants, tenantUsers, users } from '../src/db/schema'

const DATABASE_URL = process.env.DATABASE_URL
const TENANCY_MODE = process.env.TENANCY_MODE === 'single' ? 'single' : 'multi'
const APP_NAME = process.env.APP_NAME || 'GMGO Starter'
const APP_URL = process.env.APP_URL || 'http://localhost:3000'

const SEED_USERS = [
  { email: 'owner@example.test', name: 'Olivia Owner', role: 'owner' },
  { email: 'admin@example.test', name: 'Adam Admin', role: 'admin' },
  { email: 'member@example.test', name: 'Mia Member', role: 'member' },
] as const
const GLOBAL_ADMIN = { email: 'admin@gmgo.local', name: 'Platform Admin' }
const INVITED_EMAIL = 'invited@example.test'
const SEED_KEY_NAME = 'Seed key'

async function upsertUser(
  db: Database,
  input: { email: string; name: string; isGlobalAdmin?: boolean }
) {
  const existing = await db.query.users.findFirst({
    where: sql`lower(${users.email}) = ${input.email.toLowerCase()}`,
  })
  if (existing) {
    if (input.isGlobalAdmin && !existing.isGlobalAdmin) {
      await db.update(users).set({ isGlobalAdmin: true }).where(eq(users.id, existing.id))
    }
    return existing
  }
  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      name: input.name,
      isGlobalAdmin: input.isGlobalAdmin ?? false,
      emailVerifiedAt: new Date(),
    })
    .returning()
  if (!created) throw new Error(`seed: could not create ${input.email}`)
  return created
}

async function ensureMembership(
  db: Database,
  tenantId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member'
) {
  await db.insert(tenantUsers).values({ tenantId, userId, role }).onConflictDoNothing()
}

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required (pnpm seed loads .dev.vars)')
  if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && !process.env.SEED_ALLOW_REMOTE) {
    throw new Error('Refusing to seed a non-local database (set SEED_ALLOW_REMOTE=1 to override)')
  }
  const db = getScriptDatabase(DATABASE_URL)
  const log = (s: string) => console.log(s)

  log(`Seeding (${TENANCY_MODE}-tenant mode)…`)
  const owner = await upsertUser(db, SEED_USERS[0])

  let tenant: typeof tenants.$inferSelect
  if (TENANCY_MODE === 'single') {
    const single = await getSingleTenant(db)
    tenant =
      single ??
      (await createTenantForUser(db, {
        name: APP_NAME,
        slug: 'default',
        userId: owner.id,
        role: 'owner',
      }))
  } else {
    const acme = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'acme') })
    tenant =
      acme ??
      (await createTenantForUser(db, {
        name: 'Acme',
        slug: 'acme',
        userId: owner.id,
        role: 'owner',
      }))
  }
  log(`  tenant  ${tenant.name} (${tenant.slug})`)

  for (const seedUser of SEED_USERS) {
    const user = await upsertUser(db, seedUser)
    await ensureMembership(db, tenant.id, user.id, seedUser.role)
    log(`  user    ${seedUser.email.padEnd(24)} ${seedUser.role}`)
  }

  const globalAdmin = await upsertUser(db, { ...GLOBAL_ADMIN, isGlobalAdmin: true })
  if (TENANCY_MODE === 'single') await ensureMembership(db, tenant.id, globalAdmin.id, 'member')
  log(`  user    ${GLOBAL_ADMIN.email.padEnd(24)} global admin`)

  const pendingInvite = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.tenantId, tenant.id),
      sql`lower(${teamInvitations.email}) = ${INVITED_EMAIL}`,
      isNull(teamInvitations.acceptedAt),
      isNull(teamInvitations.revokedAt)
    ),
  })
  if (!pendingInvite) {
    const token = randomToken(32)
    await db.insert(teamInvitations).values({
      tenantId: tenant.id,
      email: INVITED_EMAIL,
      role: 'member',
      tokenHash: await hashToken(token),
      invitedByUserId: owner.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending → ${APP_URL}/invite/${token}`)
  } else {
    log(`  invite  ${INVITED_EMAIL.padEnd(24)} pending (existing)`)
  }

  const existingKey = await db.query.apiKeys.findFirst({
    where: and(
      eq(apiKeys.tenantId, tenant.id),
      eq(apiKeys.name, SEED_KEY_NAME),
      isNull(apiKeys.revokedAt)
    ),
  })
  if (!existingKey) {
    const { plaintext } = await mintApiKey(db, {
      tenantId: tenant.id,
      createdByUserId: owner.id,
      name: SEED_KEY_NAME,
      scopes: ['read', 'write'],
    })
    log('')
    log('  API key (shown ONCE — only its hash is stored):')
    log(`    ${plaintext}`)
  } else {
    log(
      `  API key ${existingKey.keyPrefix}… already exists (revoke it and re-seed to mint a new one)`
    )
  }

  log('')
  log('Sign in locally (APP_ENV=development) without email:')
  log(`  curl -sS -X POST ${APP_URL.replace(':3000', ':3001')}/auth/dev-login \\`)
  log(
    `    -H 'Content-Type: application/json' -d '{"email":"${SEED_USERS[0].email}"}' -c cookies.txt`
  )
  log(
    `  or open ${APP_URL}/login and use the dev-login form with any *@example.test address above.`
  )
  log(`  Magic links are logged by wrangler dev when RESEND_API_KEY is unset.`)
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => closeAllDatabases())
