/**
 * The authorization server's contracts: what the consent page reads and posts, and the
 * connections an admin (per organisation) and a person (across their organisations) see and
 * revoke. The OAuth wire documents themselves (metadata, the token response) are the RFCs' shapes
 * and are built by the server; these are the app's own screens. Nothing here names the product.
 */
import { z } from 'zod'
import { mcpScopeSchema } from './mcp'

/** The id of a pending authorization request, carried in `/consent?request=<id>`. */
export const oauthRequestIdSchema = z.string().uuid()

/** One organisation the person could connect the client to, with what it would get there. */
export const consentOrganisationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  /** The tools a client would see in this organisation under its current settings. */
  tools: z.array(z.object({ name: z.string(), title: z.string().nullable() })),
  /** A live connection from this client here already exists (approving reuses it). */
  connected: z.boolean(),
})
export type ConsentOrganisation = z.infer<typeof consentOrganisationSchema>

/** `GET /oauth/consent/:request` — everything the consent page shows. */
export const consentDetailsSchema = z.object({
  requestId: z.string().uuid(),
  /** The deployment's own name: "<client> wants to use <appName> as you". */
  appName: z.string(),
  client: z.object({
    /** What the client's metadata document says it is called — a claim, not a fact. */
    claimedName: z.string(),
    claimedLogoUri: z.string().url().nullable(),
    /** The host its `client_id` document was fetched from — the one thing that was verified. */
    verifiedHost: z.string(),
    clientId: z.string().url(),
  }),
  /** Where the browser goes after approval (host only; `localhost` for a desktop/CLI client). */
  redirectHost: z.string(),
  /** Every registered redirect is loopback: the client runs on this computer, not as a website. */
  loopbackOnly: z.boolean(),
  scopes: z.array(mcpScopeSchema),
  /** Organisations the person may connect it to. Empty → nothing to approve (the page says why). */
  organisations: z.array(consentOrganisationSchema),
  /** The URL fixes the organisation (`/mcp/t/<slug>`): the picker has exactly that one, or none. */
  organisationFixed: z.boolean(),
  /** Single-tenant deployment: there is no picker at all. */
  singleTenant: z.boolean(),
})
export type ConsentDetails = z.infer<typeof consentDetailsSchema>

/** `POST /oauth/consent` — approve (with the organisation chosen) or deny. */
export const consentDecisionSchema = z.discriminatedUnion('approve', [
  z.object({
    requestId: z.string().uuid(),
    approve: z.literal(true),
    tenantId: z.string().uuid(),
  }),
  z.object({ requestId: z.string().uuid(), approve: z.literal(false) }),
])
export type ConsentDecision = z.infer<typeof consentDecisionSchema>

/** The page navigates there: the client's redirect URI with `code`|`error`, `state` and `iss`. */
export const consentDecisionResponseSchema = z.object({ redirectTo: z.string().url() })
export type ConsentDecisionResponse = z.infer<typeof consentDecisionResponseSchema>

/** One connection (a grant), as an admin or its owner sees it. */
export const mcpConnectionSchema = z.object({
  id: z.string().uuid(),
  tenant: z.object({ id: z.string().uuid(), name: z.string(), slug: z.string() }),
  user: z.object({ id: z.string().uuid(), email: z.string(), name: z.string().nullable() }),
  client: z.object({
    clientId: z.string(),
    /** The name the client's document claims, when it was ever fetched. */
    name: z.string().nullable(),
    verifiedHost: z.string(),
  }),
  scopes: z.array(mcpScopeSchema),
  /** `/mcp` or `/mcp/t/<slug>` — the URL it was connected on. */
  resource: z.string(),
  createdAt: z.coerce.date(),
  lastUsedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  /** Calls in the last 30 days. */
  calls30d: z.number().int().nonnegative(),
  /** `live`, or why it ended. A revoked connection stays in the list with who ended it. */
  status: z.enum(['live', 'revoked', 'expired', 'idle']),
  revokedAt: z.coerce.date().nullable(),
  revokeReason: z.string().nullable(),
})
export type McpConnection = z.infer<typeof mcpConnectionSchema>

export const mcpConnectionListResponseSchema = z.object({ items: z.array(mcpConnectionSchema) })
export type McpConnectionListResponse = z.infer<typeof mcpConnectionListResponseSchema>

export const mcpConnectionListQuerySchema = z.object({
  /** `live` (default) hides connections that have ended. */
  status: z.enum(['live', 'all']).default('live'),
})

/** `POST /api/mcp/connections/revoke-all` → how many ended. */
export const mcpRevokeAllResponseSchema = z.object({ revoked: z.number().int().nonnegative() })
export type McpRevokeAllResponse = z.infer<typeof mcpRevokeAllResponseSchema>
