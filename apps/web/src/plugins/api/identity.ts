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
 * unverified email is never signed in or linked to an existing account, a membership it writes is
 * `source = 'idp'` (read-only in the app — 409 `idp_managed`), and `owner`/`support`/`manual` rows
 * are never removed by it, and nothing it does is global: `deprovision` ends a person's presence in
 * ONE tenant and never blocks them, because a tenant's IdP does not speak for their other tenants.
 *
 * **`subject` is the plugin's to namespace.** It is stored verbatim as `provider_user_id`, unique
 * per plugin: a plugin with several connections makes it unique across them itself, e.g.
 * `<connectionId>|<nameId>` — two IdPs may both call somebody `jane`.
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
import {
  completeLogin,
  type LoginErrorCode,
  loginErrorRedirect,
  safeRedirectPath,
} from '../../api/routes/auth/helpers'
import { admitUser, findUserByEmail } from '../../api/services/auth'
import {
  deprovisionIdpMember,
  removeIdpMembership,
  upsertIdpMembership,
} from '../../api/services/idp-tenancy'
import type { AppContext } from '../../api/types'
import { ConflictError, NotFoundError } from '../../api/utils/core/errors'
import { tenants, tenantUsers, type User, users } from '../../db/schema'
import type { MembershipRole } from './auth'
import type { PluginContext } from './types'

export type { IdpAppRole } from '@rocketflare/shared/idp'
export type { PluginLoginMethodDeclaration } from '../../api/auth/plugin-login-methods'

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
   * May this sign-in attach to an EXISTING account that has the same email but no link from this
   * plugin yet? Default `false`: such a sign-in is refused (`/login?error=account_exists`), because
   * a per-tenant IdP can assert any address — linking by email would let one customer's IdP sign in
   * as anyone. Pass `true` only when the plugin has proved this IdP speaks for the email's domain
   * (a DNS-verified domain on the connection).
   */
  linkByEmail?: boolean
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
  /** Sessions pinned to the tenant that were deleted. */
  sessionsEnded: number
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
   * blocked (`blocked: true` comes back). An EXISTING account with that email and no link from
   * this plugin is linked only with `linkByEmail: true` (the plugin proved the IdP owns the email's
   * domain), else 409 `account_exists`; an unverified email never links: 409 `email_unverified`. A subject already linked to somebody else: 409
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
   * Answers the row as it now stands. 404 when the tenant or the person does not exist.
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
   * `removeMembership` does AND END (delete) the sessions pinned to that tenant. Never global: no
   * block, and sessions selected to another tenant — and every other membership — survive, since
   * this IdP speaks for this tenant only. API keys they created in the tenant stop authenticating
   * with the membership. A `manual`, `owner` or `support` row is not the IdP's: it is left, with
   * its sessions, and comes back as `retained` (`removed: false`). Idempotent; 404 when the
   * tenant does not exist.
   */
  deprovision(input: { tenantId: string; userId: string }): Promise<PluginDeprovisionResult>
  /** Every member of the tenant, oldest first, with `source` — what a SCIM `GET /Users` lists. */
  listMembers(input: { tenantId: string }): Promise<PluginMember[]>
}

/** `identityFor(c, pluginId)`: sign a person in, or provision them. */
export interface PluginIdentity {
  /**
   * Finish a sign-in the plugin's IdP proved: find the person by their link (else by verified
   * email, else admit them), link them, apply `tenantId` + `role`, mint the session (cookie set,
   * the `OIDC_SESSION_MAX_AGE_DAYS` cap under managed tenancy) and answer the redirect. Every
   * refusal is a redirect to `/login?error=<code>` — `email_unverified`, `blocked`,
   * `not_invited`, `provider_linked_elsewhere`, `no_access` (the tenant does not exist),
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

async function tenantExists(db: PluginContext['db'], tenantId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(tenantId).success) return false
  const row = await db.query.tenants.findFirst({
    columns: { id: true },
    where: eq(tenants.id, tenantId),
  })
  return Boolean(row)
}

async function requireTenant(db: PluginContext['db'], tenantId: string): Promise<void> {
  if (!(await tenantExists(db, tenantId))) throw new NotFoundError('Tenant not found')
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
        const byEmail = await findUserByEmail(db, email)
        if (byEmail) {
          // Linking an address nobody proved to an existing account would hand that account over.
          if (!input.emailVerified) {
            throw new ConflictError(
              'The email is not verified, so it cannot be linked to an existing account',
              'email_unverified'
            )
          }
          // A per-tenant IdP may assert any address: only a proved domain links by email.
          if (!input.linkByEmail) {
            throw new ConflictError(
              'An account with that email exists and this identity provider may not claim it',
              ERROR_CODES.accountExists
            )
          }
          user = byEmail
        }
      }
      if (!user) {
        const admitted = await admitUser(
          db,
          ctx.config,
          { email, name, verified: input.emailVerified, admittedBy: 'idp' },
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
      await requireTenant(db, tenantId)
      if (!(await userById(db, userId))) throw new NotFoundError('User not found')
      await upsertIdpMembership(db, {
        tenantId,
        userId,
        role: z.enum(['admin', 'member']).parse(role),
      })
      const row = await db.query.tenantUsers.findFirst({
        columns: { role: true, source: true },
        where: and(eq(tenantUsers.tenantId, tenantId), eq(tenantUsers.userId, userId)),
      })
      if (!row) throw new NotFoundError('Member not found')
      return row
    },

    async removeMembership({ tenantId, userId }) {
      await requireTenant(db, tenantId)
      if (!z.string().uuid().safeParse(userId).success) return false
      return removeIdpMembership(db, { tenantId, userId })
    },

    async deprovision({ tenantId, userId }) {
      await requireTenant(db, tenantId)
      if (!z.string().uuid().safeParse(userId).success) {
        return { removed: false, sessionsEnded: 0, retained: null }
      }
      return deprovisionIdpMember(db, { tenantId, userId })
    },

    async listMembers({ tenantId }) {
      await requireTenant(db, tenantId)
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
      if (input.tenantId && !(await tenantExists(db, input.tenantId))) {
        logger.warn({ plugin: pluginId, tenantId: input.tenantId }, 'identity.signIn: no tenant')
        return refuse('no_access')
      }
      const grants =
        input.tenantId && input.role ? { tenantId: input.tenantId, role: input.role } : null

      // 1. The link wins; 2. else the verified email; 3. else admission.
      let user = await userBySubject(db, provider, input.subject)
      if (user?.blockedAt) return refuse('blocked')
      if (!user && !input.linkByEmail && (await findUserByEmail(db, input.email))) {
        // `admitUser` would hand back the existing account; a per-tenant IdP may assert any
        // address, so without a proved domain that is a takeover, not a sign-in.
        logger.warn({ plugin: pluginId }, 'identity.signIn: email belongs to an unlinked account')
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
