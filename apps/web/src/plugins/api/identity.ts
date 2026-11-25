/**
 * `identityFor(c, pluginId)` — how a plugin signs a person in and provisions memberships without
 * touching `user_sessions`, cookie flags, sign-up rules or `tenant_users` itself. The plugin's own
 * identity provider (a SAML assertion, a SCIM call, a per-tenant OIDC connection) PROVES who the
 * person is; this module does everything after that, through the same functions the kit's own
 * OIDC sign-in runs: `admitUser`, a provider link, the `idp` membership primitives of
 * `services/idp-tenancy.ts`, and `completeLogin`.
 *
 * **Why a function of `(c, pluginId)` rather than a field on `PublicCtx`.** `signIn` sets a cookie
 * and answers a redirect, so it needs the Hono context — it cannot live on a context-free object
 * like `JobCtx`. And `PublicCtx` does not know which plugin built it (`publicCtx(c)` takes no id),
 * while every identity this module writes is namespaced by one: links are stored under the
 * provider `plugin:<pluginId>`, so a plugin's subjects never meet `google`, `oidc` or another
 * plugin's. Binding the id ONCE, at the call site, is what keeps that namespace from being a
 * per-call argument a handler can get wrong. `provisionFor(ctx, pluginId)` is the cookie-free half
 * on its own, for a job or a cron (a SCIM sync, a directory pull) that has a `PluginContext` and no
 * request.
 *
 * **The trust contract is `PublicCtx`'s.** Nothing here proves anything: `signIn` believes the
 * `subject`, `email` and `emailVerified` it is handed, and every method that takes a `tenantId`
 * believes the caller may speak for that tenant. The CALLER must have proved both — a verified
 * signature over the assertion, the connection row that maps this IdP to this tenant — before it
 * calls. What this module DOES enforce: the tenant exists, a blocked person is refused, an
 * unverified email is never signed in or linked to an existing account, an address whose domain
 * the plugin has not proved (`linkByEmail`) is never claimed or created, a `BOOTSTRAP_ADMIN_EMAILS`
 * address is never claimed or created at all, a suspended tenant is refused, a membership it writes
 * is `source = 'idp'` (read-only in the app — 409 `idp_managed`), and `owner`/`support`/`manual`
 * rows are never removed by it, and in `TENANCY_MODE=multi` nothing it does is global: `deprovision`
 * ends a person's presence in ONE tenant and never blocks them, because a tenant's IdP does not
 * speak for their other tenants.
 *
 * **`TENANCY_MODE=single`: the one tenant is the deployment.** Every `tenantId` must be that tenant
 * (`getSingleTenant`) — another id answers as a tenant that does not exist, so no plugin can seat
 * anybody in a second, unreachable organisation. And `deprovision` BLOCKS the leaver
 * (`users.blocked_source = 'plugin:<id>'`) and ends every session of theirs: there are no other
 * tenants for the IdP not to speak for, and without the block a magic link, Google or another
 * plugin would sign them straight back in (dev login and the bootstrap break-glass even re-seat
 * them through `onNoTenant`). Only the SAME plugin's `setMembership` — the IdP reactivating them —
 * lifts that block; an admin's block is `manual` and no plugin lifts it.
 *
 * **`subject` is the plugin's to namespace.** It is stored verbatim as `provider_user_id`, unique
 * per plugin: a plugin with several connections makes it unique across them itself, e.g.
 * `<connectionId>|<nameId>` — two IdPs may both call somebody `jane`.
 *
 * **SSO required applies here as well** (`ServerPlugin.ssoPolicy`, `api/auth/sso-policy.ts`):
 * `signIn` for an address some plugin's connection claims passes only when THIS plugin is one of
 * the claimers; another plugin's IdP asserting it is refused with `sso_required`, exactly like the
 * kit's own methods. `provisionFor` mints no session and is not checked.
 */

import { ERROR_CODES } from '@rocketflare/shared/errors'
import type { IdpAppRole } from '@rocketflare/shared/idp'
import type { MembershipSource } from '@rocketflare/shared/tenants'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  findProviderLink,
  linkPluginIdentity,
  type PluginProviderKey,
} from '../../api/auth/oauth-providers'
import { ssoAllows } from '../../api/auth/sso-policy'
import {
  completeLogin,
  type LoginErrorCode,
  loginErrorRedirect,
  safeRedirectPath,
  ssoRequiredRedirect,
} from '../../api/routes/auth/helpers'
import { admitUser, findUserByEmail, isBootstrapAdmin } from '../../api/services/auth'
import {
  blockDeprovisioned,
  deprovisionIdpMember,
  liftIdpBlock,
  removeIdpMembership,
  upsertIdpMembership,
} from '../../api/services/idp-tenancy'
import { collectingRealtime } from '../../api/services/realtime'
import type { AppContext } from '../../api/types'
import { ConflictError, ForbiddenError, NotFoundError } from '../../api/utils/core/errors'
import { getSingleTenant } from '../../api/utils/db/tenant-helpers'
import { oauthProviders, tenants, tenantUsers, type User, users } from '../../db/schema'
import type { MembershipRole } from './auth'
import type { PluginContext } from './types'

export type { IdpAppRole } from '@rocketflare/shared/idp'
export type { PluginLoginMethodDeclaration } from '../../api/auth/plugin-login-methods'
export type { SsoRequirement } from '../../api/auth/sso-policy'
export { resolveOwnerTenant } from '../../api/utils/db/tenant-helpers'

/** A person as this module answers them: plain fields, never the row. */
export interface PluginIdentityUser {
  id: string
  email: string
  name: string
  emailVerified: boolean
  blocked: boolean
}

/** What a plugin's IdP proved about the person, handed to `signIn`. */
export interface PluginSignInInput {
  /** The person's stable id at the plugin's IdP, namespaced by the plugin (`<connection>|<id>`). */
  subject: string
  email: string
  /** `false` is refused (`/login?error=email_unverified`). Pass `true` only when the IdP says so. */
  emailVerified: boolean
  /**
   * Has the plugin proved this IdP speaks for the email's domain (a DNS-verified domain on the
   * connection)? Needed for any sign-in that is not already linked, and it is what lets one attach
   * to an EXISTING account with that email or create a NEW one. Absent: `/login?error=account_exists`
   * in both cases, whether or not the account exists — a per-tenant IdP can assert any address, so
   * it may neither sign in as anyone nor reserve an address the owner has not claimed yet.
   */
  linkByEmail?: boolean
  /**
   * The connection this assertion came through. Needed when the plugin's `ssoPolicy` names one
   * (`SsoRequirement.connectionId`): only the claiming connection satisfies that claim.
   */
  connectionId?: string
  name?: string | null
  avatarUrl?: string | null
  /**
   * The tenant the IdP speaks for — proved by the CALLER. With `role`, the person gets (or keeps)
   * an `idp` membership with that role and a new person is admitted whatever `SIGNUP_MODE` says;
   * without, the session selects it only when they already belong to it.
   */
  tenantId?: string
  role?: IdpAppRole
  /** A same-origin path to land on (`safeRedirectPath`), default `/`. */
  redirectTo?: string | null
}

/** One row of `listMembers`: the membership and the person, plain fields. */
export interface PluginMember {
  userId: string
  email: string
  name: string
  role: MembershipRole
  source: MembershipSource
  joinedAt: Date
  blocked: boolean
}

/** What `provision.deprovision` did in the tenant. */
export interface PluginDeprovisionResult {
  /** An `idp` membership was removed by this call (`false` on a repeat). */
  removed: boolean
  /**
   * Sessions deleted: the ones pinned to the tenant — in single-tenant mode, when the person is
   * blocked, every session they have.
   */
  sessionsEnded: number
  /**
   * The person's account is blocked after the call. Single-tenant mode: by this deprovision (or an
   * earlier one, or an admin) — unless the IdP does not speak for them (`retained`, no link from
   * this plugin and no `idp` row) or they are a global / bootstrap admin, whom no IdP locks out of
   * the console. Multi mode: only ever an admin's block; a deprovision there never blocks.
   */
  blocked: boolean
  /** A `manual` / `owner` / `support` membership the IdP does not own, left as is; else null. */
  retained: { role: MembershipRole; source: MembershipSource } | null
}

/** Tenant-explicit user and membership writes with no session: SCIM, a directory sync. */
export interface PluginProvision {
  /** By the plugin's own subject, or by email (case-insensitive). */
  findUser(by: { subject: string } | { email: string }): Promise<PluginIdentityUser | null>
  /**
   * Create the person (with a link, without a session) or refresh their name and link. Creation is
   * an IdP admission — no `SIGNUP_MODE` gate, no personal workspace. A blocked person stays
   * blocked (`blocked: true` comes back) — a block this plugin's own `deprovision` set as well:
   * a profile refresh is not a reactivation, `setMembership` is. A subject with no link from this
   * plugin needs `linkByEmail: true` (the plugin proved the IdP owns the email's domain), whether
   * the account exists or not: else 409 `account_exists`, answered identically in both cases, and
   * always for a `BOOTSTRAP_ADMIN_EMAILS` address. An unverified email never links to an existing
   * account: 409 `email_unverified`. A subject already linked to somebody else: 409
   * `provider_linked_elsewhere`.
   */
  upsertUser(input: {
    subject: string
    email: string
    name?: string | null
    emailVerified: boolean
    linkByEmail?: boolean
  }): Promise<PluginIdentityUser>
  /**
   * Give the person an `idp` membership with `role`; an `owner` or `support` row is left as is.
   * Answers the row as it now stands. 404 when the tenant or the person does not exist, 403
   * `tenant_suspended` when the tenant is suspended (every tenant-taking method here). This is
   * the IdP (re)admitting them, so it also lifts a block THIS plugin's `deprovision` set
   * (single-tenant mode) — never an admin's or another plugin's.
   */
  setMembership(input: {
    tenantId: string
    userId: string
    role: IdpAppRole
  }): Promise<{ role: MembershipRole; source: MembershipSource }>
  /**
   * The MEMBERSHIP only — the IdP no longer grants this tenant (a role mapping or group change):
   * remove the person's `idp` row (never a `manual`, `owner` or `support` one) with their
   * per-tenant settings, and UNPIN their sessions selected to that tenant, which stay signed in
   * and fall back to another membership. `false` when there was no `idp` row to remove. 404 when
   * the tenant does not exist. For a leaver, `deprovision`.
   */
  removeMembership(input: { tenantId: string; userId: string }): Promise<boolean>
  /**
   * A leaver (SCIM `active: false`, gone from the directory): remove the `idp` membership as
   * `removeMembership` does AND END (delete) the sessions pinned to that tenant. In multi mode
   * never global: no block, and sessions selected to another tenant — and every other membership
   * — survive, since this IdP speaks for this tenant only. API keys they created in the tenant stop
   * authenticating with the membership. A `manual`, `owner` or `support` row is not the IdP's: it
   * is left, with its sessions, and comes back as `retained` (`removed: false`). Idempotent; 404
   * when the tenant does not exist.
   *
   * Single-tenant mode also BLOCKS the person (`blocked: true`) and ends every session they have,
   * because the tenant is the deployment: their API keys then answer 403 `blocked`. Only when the
   * IdP speaks for them — it just removed their `idp` row, or they are linked to this plugin — and
   * never a global or `BOOTSTRAP_ADMIN_EMAILS` admin (logged). `setMembership` reactivates them.
   */
  deprovision(input: { tenantId: string; userId: string }): Promise<PluginDeprovisionResult>
  /** Every member of the tenant, oldest first, with `source` — what a SCIM `GET /Users` lists. */
  listMembers(input: { tenantId: string }): Promise<PluginMember[]>
}

/** `identityFor(c, pluginId)`: sign a person in, or provision them. */
export interface PluginIdentity {
  /**
   * Finish a sign-in the plugin's IdP proved: find the person by their link (else, with
   * `linkByEmail`, by verified email or by admitting them), link them, apply `tenantId` + `role`,
   * mint the session (cookie set,
   * the `OIDC_SESSION_MAX_AGE_DAYS` cap under managed tenancy) and answer the redirect. Without
   * `tenantId` + `role` a NEW person is admitted by `SIGNUP_MODE` like any sign-in (single-tenant
   * mode, `open`: auto-joined as `member`). A block — including one this plugin's `deprovision`
   * set — is refused, never lifted, by a sign-in: an IdP still asserting a deactivated person is
   * out of step with its own directory. Every
   * refusal is a redirect to `/login?error=<code>` — `email_unverified`, `blocked`,
   * `not_invited`, `provider_linked_elsewhere`, `account_exists` (no `linkByEmail` for an address
   * with no link from this plugin, or a `BOOTSTRAP_ADMIN_EMAILS` address), `no_access` (the tenant
   * does not exist or is suspended — in single-tenant mode, is not THE tenant),
   * `oauth_failed` (input that would not parse) — so the handler just returns what this returns.
   */
  signIn(input: PluginSignInInput): Promise<Response>
  provision: PluginProvision
}

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/

function providerKeyOf(pluginId: string): PluginProviderKey {
  if (!PLUGIN_ID.test(pluginId)) throw new Error(`identity: '${pluginId}' is not a plugin id`)
  return `plugin:${pluginId}`
}

const subjectSchema = z.string().trim().min(1).max(512)
const emailSchema = z.string().trim().toLowerCase().email().max(320)

const signInSchema = z.object({
  subject: subjectSchema,
  email: emailSchema,
  emailVerified: z.boolean(),
  linkByEmail: z.boolean().optional(),
  connectionId: z.string().min(1).max(200).optional(),
  name: z.string().trim().max(200).nullish(),
  avatarUrl: z.string().url().max(2048).nullish(),
  tenantId: z.string().uuid().optional(),
  role: z.enum(['admin', 'member']).optional(),
  redirectTo: z.string().nullish(),
})

function toIdentityUser(user: User): PluginIdentityUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null,
    blocked: user.blockedAt !== null,
  }
}

/**
 * The tenant as a provider may act on it: `missing` when it does not exist — in
 * `TENANCY_MODE=single`, when it is not THE tenant (`getSingleTenant`): any other row is a leftover
 * nobody can reach, so seating somebody there would be a second organisation — and `suspended`,
 * which this path never reaches through the auth middleware.
 */
async function tenantState(
  db: PluginContext['db'],
  config: PluginContext['config'],
  tenantId: string
): Promise<'active' | 'suspended' | 'missing'> {
  if (!z.string().uuid().safeParse(tenantId).success) return 'missing'
  if (config.TENANCY_MODE === 'single') {
    const only = await getSingleTenant(db)
    return only?.id === tenantId ? only.status : 'missing'
  }
  const row = await db.query.tenants.findFirst({
    columns: { status: true },
    where: eq(tenants.id, tenantId),
  })
  return row?.status ?? 'missing'
}

async function requireTenant(ctx: PluginContext, tenantId: string): Promise<void> {
  const state = await tenantState(ctx.db, ctx.config, tenantId)
  if (state === 'missing') throw new NotFoundError('Tenant not found')
  if (state === 'suspended') {
    throw new ForbiddenError('Organisation is suspended', ERROR_CODES.tenantSuspended)
  }
}

/**
 * May this provider claim `email` for a subject it has no link for? Only with a proved domain:
 * a per-tenant IdP can assert any address, so without one it could sign in as an existing account
 * or reserve the address before its owner arrives. A `BOOTSTRAP_ADMIN_EMAILS` address is never
 * claimable: the link would outlive a later verified login that promotes the account to global
 * admin.
 */
function mayClaimEmail(
  config: PluginContext['config'],
  email: string,
  linkByEmail: boolean | undefined
): boolean {
  return Boolean(linkByEmail) && !isBootstrapAdmin(config, email)
}

async function linkedTo(
  db: PluginContext['db'],
  provider: PluginProviderKey,
  userId: string
): Promise<boolean> {
  const row = await db.query.oauthProviders.findFirst({
    columns: { id: true },
    where: and(eq(oauthProviders.userId, userId), eq(oauthProviders.provider, provider)),
  })
  return Boolean(row)
}

async function userById(db: PluginContext['db'], userId: string): Promise<User | undefined> {
  if (!z.string().uuid().safeParse(userId).success) return undefined
  return db.query.users.findFirst({ where: eq(users.id, userId) })
}

async function userBySubject(
  db: PluginContext['db'],
  provider: PluginProviderKey,
  subject: string
): Promise<User | undefined> {
  const link = await findProviderLink(db, provider, subject)
  return link ? userById(db, link.userId) : undefined
}

/** The cookie-free half: usable from any `PluginContext` — a public handler, a job, a cron. */
export function provisionFor(ctx: PluginContext, pluginId: string): PluginProvision {
  const provider = providerKeyOf(pluginId)
  const { db } = ctx
  // No `waitUntil` on this surface (a queue consumer can call it): the socket closes are awaited.
  const realtime = collectingRealtime(ctx.env)
  return {
    async findUser(by) {
      const user =
        'subject' in by
          ? await userBySubject(db, provider, subjectSchema.parse(by.subject))
          : await findUserByEmail(db, emailSchema.parse(by.email))
      return user ? toIdentityUser(user) : null
    },

    async upsertUser(input) {
      const subject = subjectSchema.parse(input.subject)
      const email = emailSchema.parse(input.email)
      const name = input.name?.trim() || null
      let user = await userBySubject(db, provider, subject)
      if (!user) {
        // One answer whether or not the account exists: the IdP's operator learns nothing from it.
        if (!mayClaimEmail(ctx.config, email, input.linkByEmail)) {
          throw new ConflictError(
            'This identity provider may not claim that email address',
            ERROR_CODES.accountExists
          )
        }
        const byEmail = await findUserByEmail(db, email)
        if (byEmail) {
          // Linking an address nobody proved to an existing account would hand that account over.
          if (!input.emailVerified) {
            throw new ConflictError(
              'The email is not verified, so it cannot be linked to an existing account',
              'email_unverified'
            )
          }
          user = byEmail
        }
      }
      if (!user) {
        const admitted = await admitUser(
          db,
          ctx.config,
          { email, name, verified: input.emailVerified, admittedBy: 'idp', proof: 'plugin' },
          ctx.logger
        )
        // An IdP admission is refused only for a blocked existing row, which was looked up above.
        if (!admitted.ok) throw new ConflictError('The person cannot be admitted', admitted.reason)
        user = admitted.user
      } else if (name && name !== user.name) {
        const [renamed] = await db
          .update(users)
          .set({ name, updatedAt: new Date() })
          .where(eq(users.id, user.id))
          .returning()
        user = renamed ?? user
      }
      await linkPluginIdentity(db, { userId: user.id, provider, providerUserId: subject, email })
      return toIdentityUser(user)
    },

    async setMembership({ tenantId, userId, role }) {
      await requireTenant(ctx, tenantId)
      if (!(await userById(db, userId))) throw new NotFoundError('User not found')
      await upsertIdpMembership(db, {
        tenantId,
        userId,
        role: z.enum(['admin', 'member']).parse(role),
      })
      // The IdP (re)admits them: a block its own deprovision set goes; nobody else's does.
      if (await liftIdpBlock(db, { userId, source: provider })) {
        ctx.logger.info({ plugin: pluginId, userId }, 'identity: reactivated, IdP block lifted')
      }
      const row = await db.query.tenantUsers.findFirst({
        columns: { role: true, source: true },
        where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
      })
      if (!row) throw new NotFoundError('Member not found')
      return row
    },

    async removeMembership({ tenantId, userId }) {
      await requireTenant(ctx, tenantId)
      if (!z.string().uuid().safeParse(userId).success) return false
      const removed = await removeIdpMembership(db, { tenantId, userId }, realtime)
      await realtime.flush()
      return removed
    },

    async deprovision({ tenantId, userId }) {
      await requireTenant(ctx, tenantId)
      const user = await userById(db, userId)
      if (!user) return { removed: false, sessionsEnded: 0, retained: null, blocked: false }
      const result = await deprovisionIdpMember(db, { tenantId, userId }, realtime)
      await realtime.flush()
      const blocked = user.blockedAt !== null
      // Multi mode: one tenant's IdP never speaks for the person's others — nothing global.
      if (ctx.config.TENANCY_MODE !== 'single' || result.retained) return { ...result, blocked }
      // Single mode: the tenant is the deployment. Block — but only someone this IdP speaks for.
      if (!result.removed && !blocked && !(await linkedTo(db, provider, userId))) {
        return { ...result, blocked }
      }
      if (!blocked && (user.isGlobalAdmin || isBootstrapAdmin(ctx.config, user.email))) {
        ctx.logger.warn(
          { plugin: pluginId, userId },
          'identity.deprovision: a global or bootstrap admin is never blocked by an IdP'
        )
        return { ...result, blocked }
      }
      const ended = await blockDeprovisioned(db, { userId, source: provider }, realtime)
      await realtime.flush()
      if (!blocked) {
        ctx.logger.info({ plugin: pluginId, userId }, 'identity.deprovision: blocked (single)')
      }
      return { ...result, sessionsEnded: result.sessionsEnded + ended, blocked: true }
    },

    async listMembers({ tenantId }) {
      await requireTenant(ctx, tenantId)
      const rows = await db
        .select({
          userId: tenantUsers.userId,
          email: users.email,
          name: users.name,
          role: tenantUsers.role,
          source: tenantUsers.source,
          joinedAt: tenantUsers.joinedAt,
          blocked: sql<boolean>`${users.blockedAt} is not null`,
        })
        .from(tenantUsers)
        .innerJoin(users, eq(users.id, tenantUsers.userId))
        .where(eq(tenantUsers.tenantId, tenantId))
        .orderBy(tenantUsers.joinedAt)
      return rows.map(r => ({ ...r, blocked: Boolean(r.blocked) }))
    },
  }
}

/** Both halves, bound to this request and this plugin's namespace. */
export function identityFor(c: AppContext, pluginId: string): PluginIdentity {
  const db = c.get('db')
  const config = c.get('config')
  const logger = c.get('logger')
  const provider = providerKeyOf(pluginId)
  const provision = provisionFor({ db, config, logger, env: c.env }, pluginId)
  const refuse = (code: LoginErrorCode) => loginErrorRedirect(c, code)

  return {
    provision,
    async signIn(raw) {
      if (raw.emailVerified === false) return refuse('email_unverified')
      const parsed = signInSchema.safeParse(raw)
      if (!parsed.success) {
        logger.warn(
          { plugin: pluginId, issues: parsed.error.issues.map(i => i.path.join('.')) },
          'identity.signIn: the assertion did not parse'
        )
        return refuse('oauth_failed')
      }
      const input = parsed.data
      if (input.tenantId && (await tenantState(db, config, input.tenantId)) !== 'active') {
        logger.warn(
          { plugin: pluginId, tenantId: input.tenantId },
          'identity.signIn: tenant missing or suspended'
        )
        return refuse('no_access')
      }
      const grants =
        input.tenantId && input.role ? { tenantId: input.tenantId, role: input.role } : null

      // 1. The link wins; 2. else the verified email; 3. else admission.
      let user = await userBySubject(db, provider, input.subject)
      if (user?.blockedAt) return refuse('blocked')
      // SSO required: only a plugin that claims the address may sign it in. Function-scope import:
      // `routes/auth/sso` reads the plugin barrel, which imports this module (see that file).
      const { ssoDecisionFor } = await import('../../api/routes/auth/sso')
      const sso = await ssoDecisionFor(db, config, [input.email, user?.email], logger)
      if (!ssoAllows(sso, { pluginId, connectionId: input.connectionId })) {
        logger.warn({ plugin: pluginId }, 'identity.signIn: another connection requires SSO here')
        return ssoRequiredRedirect(c, sso, { returnUrl: safeRedirectPath(input.redirectTo) })
      }
      if (!user && !mayClaimEmail(config, input.email, input.linkByEmail)) {
        // No link yet and no right to claim the address: `admitUser` would hand back or create
        // the account. One answer whether or not it exists.
        logger.warn({ plugin: pluginId }, 'identity.signIn: this IdP may not claim that email')
        return refuse('account_exists')
      }
      if (!user) {
        const admitted = await admitUser(
          db,
          config,
          {
            email: input.email,
            name: input.name,
            verified: true,
            avatarUrl: input.avatarUrl,
            admittedBy: grants ? 'idp' : undefined,
            proof: 'plugin',
          },
          logger
        )
        if (!admitted.ok) return refuse(admitted.reason)
        user = admitted.user
      }

      try {
        await linkPluginIdentity(db, {
          userId: user.id,
          provider,
          providerUserId: input.subject,
          email: input.email,
        })
      } catch (err) {
        if (err instanceof ConflictError) return refuse('provider_linked_elsewhere')
        throw err
      }

      if (grants) {
        await upsertIdpMembership(db, {
          tenantId: grants.tenantId,
          userId: user.id,
          role: grants.role,
        })
      }
      let selected: string | null = null
      if (input.tenantId) {
        const member = await db.query.tenantUsers.findFirst({
          columns: { tenantId: true },
          where: and(eq(tenantUsers.tenantId, input.tenantId), eq(tenantUsers.userId, user.id)),
        })
        selected = member?.tenantId ?? null
      }

      await completeLogin(c, db, config, user, selected)
      return c.redirect(safeRedirectPath(input.redirectTo), 302)
    },
  }
}
