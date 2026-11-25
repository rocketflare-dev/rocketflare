/**
 * IdP-managed tenancy (`OIDC_MANAGED_TENANCY=true`, docs/CONCEPTS.md §2): the OIDC issuer, not the
 * app, says which organisations a person may use the app in and with what role. Two channels carry
 * it, and this module is the contract for both:
 *
 * - **Claims.** The verified id_token carries the person's orgs under `OIDC_ORGS_CLAIM` (default
 *   `orgs`): `[{ id, name, slug?, role }]`. `role` is the issuer's own word; `OIDC_ROLE_MAP` maps it
 *   to the app's `admin` or `member`. Read on every sign-in.
 * - **Identity events.** Between sign-ins the issuer posts signed events (Standard Webhooks) to
 *   `POST /api/identity/events`: a person suspended, a membership removed or changed, the app's
 *   grant revoked, an org renamed or suspended. Applied idempotently and in any order.
 *
 * The server trusts claims only from an id_token it verified itself (`auth/providers/oidc.ts`) and
 * events only with a valid signature (`services/identity-events.ts`).
 */
import { z } from 'zod'

/** At most this many orgs are read from one id_token; a longer list is refused as malformed. */
export const IDP_ORGS_MAX = 200

/** One org the issuer grants the person this app in, with their role there. */
export const idpOrgClaimSchema = z.object({
  /** The org's stable id at the issuer: the app's `tenants.external_org_id`. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** A URL-friendly name to start the tenant's slug from; the name is slugified without it. */
  slug: z.string().min(1).optional(),
  /** The issuer's role name, mapped through `OIDC_ROLE_MAP`. */
  role: z.string().min(1),
})
export type IdpOrgClaim = z.infer<typeof idpOrgClaimSchema>

export const idpOrgsClaimSchema = z.array(idpOrgClaimSchema).max(IDP_ORGS_MAX)

/** The app roles an issuer role may map to: never `owner` (the app's own) or `support`. */
export const idpAppRoleSchema = z.enum(['admin', 'member'])
export type IdpAppRole = z.infer<typeof idpAppRoleSchema>

export const IDENTITY_EVENT_TYPES = [
  'person.suspended',
  'membership.removed',
  'membership.role_changed',
  'grant.revoked',
  'org.renamed',
  'org.suspended',
] as const
export type IdentityEventType = (typeof IDENTITY_EVENT_TYPES)[number]

/**
 * The person an event is about. `sub` is their subject at the issuer (absent before their first
 * sign-in) and is matched against the OIDC provider link first; `email` is the fallback.
 * `personId` is the issuer's own id for them, kept for logs.
 */
const personRefSchema = z.object({
  personId: z.string().min(1),
  email: z.string().min(1),
  sub: z.string().min(1).optional(),
})
export type IdentityPersonRef = z.infer<typeof personRefSchema>

/** What every event shares: a unique, sortable id and when the change happened at the issuer. */
export const identityEventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  data: z.unknown(),
})

const base = { id: z.string().min(1), occurredAt: z.string().datetime({ offset: true }) }

export const identityEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('person.suspended'), data: personRefSchema }),
  z.object({
    ...base,
    type: z.literal('membership.removed'),
    data: personRefSchema.extend({ orgId: z.string().min(1) }),
  }),
  z.object({
    ...base,
    type: z.literal('membership.role_changed'),
    data: personRefSchema.extend({ orgId: z.string().min(1), role: z.string().min(1) }),
  }),
  z.object({
    ...base,
    type: z.literal('grant.revoked'),
    // Without a person, the org-wide grant: no member of the org may use the app through it.
    data: z.object({ orgId: z.string().min(1), person: personRefSchema.optional() }),
  }),
  z.object({
    ...base,
    type: z.literal('org.renamed'),
    data: z.object({ orgId: z.string().min(1), name: z.string().min(1) }),
  }),
  z.object({
    ...base,
    type: z.literal('org.suspended'),
    data: z.object({ orgId: z.string().min(1) }),
  }),
])
export type IdentityEvent = z.infer<typeof identityEventSchema>
