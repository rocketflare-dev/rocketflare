/**
 * An invitation admits a new account only while its issuer could still issue it: under
 * `invite_only`, an open invitation whose issuer is blocked, or no longer holds a role that could
 * issue it, is no invitation at all. And blocking a person revokes the invitations they issued, in
 * every tenant, in the block's transaction.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { setUserBlocked } from '@/api/services/admin'
import { admitUser } from '@/api/services/auth'
import { createInvitation } from '@/api/services/invitations'
import { loadConfig } from '@/config'
import type { InvitationRole, User } from '@/db/schema'
import { teamInvitations, tenantUsers, users } from '@/db/schema'
import {
  createTestGlobalAdmin,
  createTestTenantWithUser,
  createTestUser,
  linkUserToTenant,
  uniqueId,
} from '../../helpers/auth'
import { setupTestDatabase } from '../../helpers/db'
import { createTestEnv, RecordingQueue } from '../../mocks/bindings'

const db = setupTestDatabase()
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never
const cfg = loadConfig(createTestEnv({ SIGNUP_MODE: 'invite_only' }))
const newEmail = () => `invitee_${uniqueId().toLowerCase()}@example.test`

async function invite(
  tenantId: string,
  inviter: User,
  role: InvitationRole = 'member',
  email = newEmail()
) {
  await createInvitation(db, cfg, logger, new RecordingQueue() as never, {
    tenantId,
    email,
    role,
    inviter,
    actor: { isGlobalAdmin: inviter.isGlobalAdmin, tenantUser: { role: 'owner' } },
  })
  return email
}

async function adminOfNewTenant() {
  const { tenant } = await createTestTenantWithUser(db, 'owner')
  const admin = await createTestUser(db)
  await linkUserToTenant(db, admin.id, tenant.id, 'admin')
  return { tenant, admin }
}

function admit(email: string) {
  return admitUser(db, cfg, { email, verified: true, proof: 'kit' }, logger)
}

async function accountExists(email: string) {
  return Boolean(await db.query.users.findFirst({ where: eq(users.email, email) }))
}

describe('invite_only admission follows the issuer’s authority', () => {
  it('an invitation from an issuer who may still issue it admits the invitee', async () => {
    const { tenant, admin } = await adminOfNewTenant()
    const email = await invite(tenant.id, admin)
    expect((await admit(email)).ok).toBe(true)
    expect(await accountExists(email)).toBe(true)
  })

  it('an invitation whose issuer is blocked admits no account', async () => {
    const { tenant, admin } = await adminOfNewTenant()
    const email = await invite(tenant.id, admin)
    // A block that revoked nothing itself (as an identity provider's can): the row stays open.
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, admin.id))

    expect(await admit(email)).toEqual({ ok: false, reason: 'not_invited' })
    expect(await accountExists(email)).toBe(false)
  })

  it('an invitation whose issuer’s role can no longer issue it admits no account', async () => {
    const { tenant, admin } = await adminOfNewTenant()
    const email = await invite(tenant.id, admin)
    await db
      .update(tenantUsers)
      .set({ role: 'member' })
      .where(and(eq(tenantUsers.tenantId, tenant.id), eq(tenantUsers.userId, admin.id)))

    expect(await admit(email)).toEqual({ ok: false, reason: 'not_invited' })
    expect(await accountExists(email)).toBe(false)
  })

  it('one valid invitation among stale ones still admits', async () => {
    const stale = await adminOfNewTenant()
    const valid = await adminOfNewTenant()
    const email = await invite(stale.tenant.id, stale.admin)
    await invite(valid.tenant.id, valid.admin, 'member', email)
    await db.update(users).set({ blockedAt: new Date() }).where(eq(users.id, stale.admin.id))

    expect((await admit(email)).ok).toBe(true)
  })

  it('a global admin’s invitation admits without a membership in the tenant', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const globalAdmin = await createTestGlobalAdmin(db)
    const email = await invite(tenant.id, globalAdmin, 'owner')
    expect((await admit(email)).ok).toBe(true)
  })
})

describe('blocking a person revokes the invitations they issued', () => {
  it('revokes their pending invitations in every tenant', async () => {
    const first = await adminOfNewTenant()
    const { tenant: second } = await createTestTenantWithUser(db, 'owner')
    await linkUserToTenant(db, first.admin.id, second.id, 'owner')
    const a = await invite(first.tenant.id, first.admin)
    const b = await invite(second.id, first.admin, 'owner')
    const other = await adminOfNewTenant()
    const untouched = await invite(other.tenant.id, other.admin)

    await setUserBlocked(db, { userId: first.admin.id, blocked: true })

    const open = await db
      .select({ email: teamInvitations.email })
      .from(teamInvitations)
      .where(isNull(teamInvitations.revokedAt))
    const openEmails = open.map(r => r.email)
    expect(openEmails).not.toContain(a)
    expect(openEmails).not.toContain(b)
    expect(openEmails).toContain(untouched)
    expect(await admit(a)).toEqual({ ok: false, reason: 'not_invited' })
  })

  it('revokes a blocked global admin’s invitations too', async () => {
    const { tenant } = await createTestTenantWithUser(db, 'owner')
    const globalAdmin = await createTestGlobalAdmin(db)
    const email = await invite(tenant.id, globalAdmin)

    await setUserBlocked(db, { userId: globalAdmin.id, blocked: true })

    const row = await db.query.teamInvitations.findFirst({
      where: eq(teamInvitations.email, email),
    })
    expect(row?.revokedAt).not.toBeNull()
  })

  it('unblocking restores no invitation', async () => {
    const { tenant, admin } = await adminOfNewTenant()
    const email = await invite(tenant.id, admin)
    await setUserBlocked(db, { userId: admin.id, blocked: true })
    await setUserBlocked(db, { userId: admin.id, blocked: false })

    expect(await admit(email)).toEqual({ ok: false, reason: 'not_invited' })
  })
})
