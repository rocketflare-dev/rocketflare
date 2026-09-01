/**
 * Auth fixtures (D12, D15): users, tenants, memberships, sessions and API keys inserted the way
 * production writes them — credentials stored as `hashToken(raw)`, the raw value returned for the
 * request. Every factory suffixes `uniqueId()` so parallel files never collide, and rows are left
 * behind on purpose (see .claude/rules/testing.md — no per-file truncation).
 */
import { generateApiKey, hashToken } from '@/api/utils/core/hash'
import { randomToken } from '@/api/utils/core/ids'
import type { Database } from '@/db/client'
import {
  apiKeys,
  type MembershipRole,
  type NewApiKey,
  type NewTenant,
  type NewUser,
  tenants,
  tenantUsers,
  userSessions,
  users,
} from '@/db/schema'

/**
 * The session cookie's name (CLAUDE.md: `__Host-session`). The auth agent should export this
 * from the auth module and point this constant at it; until then it is pinned here.
 */
export const SESSION_COOKIE_NAME = '__Host-session'

/** Unique suffix for parallel-safe fixtures. */
export function uniqueId(): string {
  return `${Date.now().toString(36)}_${randomToken(4)}`.replace(/[^a-z0-9_]/gi, 'x')
}

export async function createTestUser(db: Database, overrides: Partial<NewUser> = {}) {
  const id = uniqueId().toLowerCase()
  const [user] = await db
    .insert(users)
    .values({
      email: `user_${id}@example.test`,
      name: `Test User ${id}`,
      avatarUrl: null,
      isGlobalAdmin: false,
      emailVerifiedAt: new Date(),
      ...overrides,
    })
    .returning()
  if (!user) throw new Error('createTestUser: insert returned no row')
  return user
}

/** A platform staff account (`users.isGlobalAdmin`), the gate for `/api/admin/*`. */
export function createTestGlobalAdmin(db: Database, overrides: Partial<NewUser> = {}) {
  return createTestUser(db, { ...overrides, isGlobalAdmin: true })
}

export async function createTestTenant(db: Database, overrides: Partial<NewTenant> = {}) {
  const id = uniqueId().toLowerCase()
  const [tenant] = await db
    .insert(tenants)
    .values({ name: `Test Org ${id}`, slug: `test-org-${id}`, ...overrides })
    .returning()
  if (!tenant) throw new Error('createTestTenant: insert returned no row')
  return tenant
}

/** Membership row. `support` is allowed here because fixtures must reach states only /admin mints. */
export async function linkUserToTenant(
  db: Database,
  userId: string,
  tenantId: string,
  role: MembershipRole = 'member',
  invitedByUserId: string | null = null
) {
  const [membership] = await db
    .insert(tenantUsers)
    .values({ tenantId, userId, role, invitedByUserId })
    .returning()
  if (!membership) throw new Error('linkUserToTenant: insert returned no row')
  return membership
}

/** Tenant + one member in one call (default `owner`). */
export async function createTestTenantWithUser(
  db: Database,
  role: MembershipRole = 'owner',
  userOverrides: Partial<NewUser> = {},
  tenantOverrides: Partial<NewTenant> = {}
) {
  const user = await createTestUser(db, userOverrides)
  const tenant = await createTestTenant(db, tenantOverrides)
  const membership = await linkUserToTenant(db, user.id, tenant.id, role)
  return { user, tenant, membership }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A cookie session for `userId` (optionally pinned to `tenantId`). Returns the COOKIE VALUE — the
 * raw token; the row stores only `hashToken(token)`.
 */
export async function createTestSession(
  db: Database,
  userId: string,
  tenantId?: string | null,
  options: { expiresInDays?: number; ip?: string; userAgent?: string } = {}
): Promise<string> {
  const token = randomToken(32)
  const [session] = await db
    .insert(userSessions)
    .values({
      userId,
      tokenHash: await hashToken(token),
      selectedTenantId: tenantId ?? null,
      expiresAt: new Date(Date.now() + (options.expiresInDays ?? 7) * DAY_MS),
      ip: options.ip ?? '127.0.0.1',
      userAgent: options.userAgent ?? 'vitest',
    })
    .returning({ id: userSessions.id })
  if (!session) throw new Error('createTestSession: insert returned no row')
  return token
}

/** `{ Cookie }` header for a token from `createTestSession`. */
export function sessionCookieHeader(token: string): Record<string, string> {
  return { Cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

/**
 * A tenant API key created by `userId` (who must be a member). Returns the plaintext `key` for an
 * `Authorization: Bearer` header plus the stored row.
 */
export async function createTestApiKey(
  db: Database,
  tenantId: string,
  userId: string,
  overrides: Partial<Omit<NewApiKey, 'keyHash' | 'keyPrefix'>> = {}
) {
  const { key, keyHash, keyPrefix } = await generateApiKey()
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId,
      createdByUserId: userId,
      name: `Test key ${uniqueId()}`,
      keyHash,
      keyPrefix,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('createTestApiKey: insert returned no row')
  return { key, row }
}

export function bearerHeader(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` }
}

// ---- Global seed (tests/setup.ts → provide/inject) ------------------------------------------

/** Plain, JSON-serialisable — vitest's `provide()` requires it. */
export interface TestSeed {
  user: { id: string; email: string; name: string }
  tenant: { id: string; name: string; slug: string }
  /** `owner` membership of `user` in `tenant`. */
  role: MembershipRole
  /** Plaintext API key for `tenant`, created by `user`. */
  apiKey: string
  /** Cookie value (raw session token) for `user`, selected tenant = `tenant`. */
  sessionToken: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    seed: TestSeed
  }
}

/** One owner + tenant + API key + session, seeded once per run by `tests/setup.ts`. */
export async function seedTestFixtures(db: Database): Promise<TestSeed> {
  const { user, tenant, membership } = await createTestTenantWithUser(
    db,
    'owner',
    { email: 'seed-owner@example.test', name: 'Seed Owner' },
    { name: 'Seed Org', slug: 'seed-org' }
  )
  const { key } = await createTestApiKey(db, tenant.id, user.id, { name: 'Seed key' })
  const sessionToken = await createTestSession(db, user.id, tenant.id)
  return {
    user: { id: user.id, email: user.email, name: user.name },
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    role: membership.role,
    apiKey: key,
    sessionToken,
  }
}
