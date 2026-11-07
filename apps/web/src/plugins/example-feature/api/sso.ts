/**
 * `/api/hooks/example-feature/sso` — an EXAMPLE single sign-on, **development only**, to show the
 * shape of `identityFor(c, id).signIn` and `ServerPlugin.loginMethods`. Delete it with the plugin.
 *
 *   GET /sso/start?email=…[&tenantId=…&role=admin|member][&returnUrl=…]   → 302 to the callback
 *   GET /sso/callback?state=…                                          → signs in, 302 onward
 *
 * A real SSO plugin's `start` redirects to the person's identity provider and its callback (a SAML
 * ACS, an OIDC redirect) VERIFIES what the provider sent — a signature over the assertion, an
 * id_token — and looks up which tenant that connection belongs to. This example has no provider,
 * so `start` plays it: it asserts whatever email it is given and signs that assertion with
 * `signState`, and the callback verifies the signature exactly as a real one verifies the IdP's.
 * That is why both routes 404 outside `APP_ENV=development`: an IdP that vouches for anybody is a
 * dev-login, and it must never ship.
 *
 * What the callback shows, and what a real plugin copies:
 *
 * 1. **Prove the assertion** (`verifyState` here; XML-DSig or `jose` for real), then parse it — a
 *    signature proves who wrote it, not its shape.
 * 2. **Re-check the flag** for the tenant the assertion names (no `requireFeature` can run here).
 * 3. **Hand the person to `signIn`** and return what it returns. The plugin never writes a session,
 *    a cookie, a user row or a membership; refusals (an unverified email, a blocked person) come
 *    back as the kit's own `/login?error=` redirects.
 *
 * `subject` is namespaced by the plugin: `demo|<email>`. A plugin with several connections makes it
 * `<connectionId>|<nameId>`, because two identity providers may both call somebody `jane`.
 */
import {
  EXAMPLE_FEATURE_FLAG,
  EXAMPLE_FEATURE_ID,
} from '@rocketflare/shared/plugins/example-feature/index'
import { z } from 'zod'
import type { PublicCtx } from '@/plugins/api'
import { createRouter, identityFor, publicCtx, signState, verifyState } from '@/plugins/api'
import { EXAMPLE_SSO_PURPOSE, EXAMPLE_SSO_TTL_SECONDS } from '../shared'

const startQuerySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  tenantId: z.string().uuid().optional(),
  role: z.enum(['admin', 'member']).optional(),
  returnUrl: z.string().optional(),
})

/** The "assertion" the pretend IdP signs. Parsed again on the way back in. */
const assertionSchema = z.object({
  subject: z.string().min(1),
  email: z.string().email(),
  emailVerified: z.boolean(),
  linkByEmail: z.boolean(),
  tenantId: z.string().uuid().optional(),
  role: z.enum(['admin', 'member']).optional(),
  redirectTo: z.string().optional(),
})
export type ExampleSsoAssertion = z.infer<typeof assertionSchema>

/** Where the login page's button goes (`ServerPlugin.loginMethods` in `../index.ts`). */
export const EXAMPLE_SSO_START_PATH = `/api/hooks/${EXAMPLE_FEATURE_ID}/sso/start`

export const exampleSsoRouter = createRouter()

function requireDevelopment(ctx: PublicCtx) {
  if (ctx.config.APP_ENV !== 'development') ctx.notFound()
}

exampleSsoRouter.get('/start', async c => {
  const ctx: PublicCtx = publicCtx(c)
  requireDevelopment(ctx)
  const query = startQuerySchema.safeParse(c.req.query())
  if (!query.success) ctx.badRequest('An email address is required', 'validation_error')
  const { email, tenantId, role, returnUrl } = query.data
  const assertion: ExampleSsoAssertion = {
    subject: `demo|${email}`,
    email,
    // A real plugin passes what its IdP says, never a constant.
    emailVerified: true,
    // Lets this sign-in attach to an existing account with the same email. A real plugin sets it
    // ONLY when the email's domain is one this connection proved it owns (a DNS-verified domain);
    // otherwise one tenant's IdP could sign in as anyone. The dev-only pretend IdP plays dev login.
    linkByEmail: true,
    tenantId,
    role,
    redirectTo: returnUrl,
  }
  const state = await signState(ctx.config, EXAMPLE_SSO_PURPOSE, assertion, {
    ttlSeconds: EXAMPLE_SSO_TTL_SECONDS,
  })
  return c.redirect(
    `/api/hooks/${EXAMPLE_FEATURE_ID}/sso/callback?state=${encodeURIComponent(state)}`,
    302
  )
})

exampleSsoRouter.get('/callback', async c => {
  const ctx: PublicCtx = publicCtx(c)
  requireDevelopment(ctx)
  const assertion = assertionSchema.safeParse(
    await verifyState(ctx.config, EXAMPLE_SSO_PURPOSE, c.req.query('state') ?? '')
  )
  if (!assertion.success) ctx.unauthorized('This sign-in is invalid or has expired')
  const { tenantId } = assertion.data
  if (tenantId && !(await ctx.features(tenantId)).includes(EXAMPLE_FEATURE_FLAG)) {
    ctx.notFound('Not found', 'feature_disabled')
  }
  return identityFor(c, EXAMPLE_FEATURE_ID).signIn(assertion.data)
})
