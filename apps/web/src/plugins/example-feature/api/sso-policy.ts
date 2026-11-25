/**
 * `ServerPlugin.ssoPolicy` for the example SSO: every address at `@sso-required.example.test`
 * must sign in through the `demo-sso` method, development only (like the pretend IdP behind it,
 * `./sso.ts`). The kit then refuses that domain a magic link, Google, Microsoft, OIDC and dev
 * login, and only this plugin's own `identityFor().signIn` lets it in.
 *
 * A real plugin answers from its connections' DNS-verified domains with ONE indexed lookup on the
 * email's domain (it is asked on every sign-in attempt), answers `null` for a domain no connection
 * claims, and lets a genuine failure throw — the kit fails closed for that email and logs it.
 *
 * Its own file, importing only TYPES from `@/plugins/api`, so a pure test can load it without
 * evaluating the plugin barrel (`./sso.ts` builds a router at module scope).
 */
import type { PluginConfig, SsoRequirement } from '@/plugins/api'

/** `ServerPlugin.loginMethods` id of the example SSO button (namespaced `example-feature:demo-sso`). */
export const EXAMPLE_SSO_METHOD_ID = 'demo-sso'

/** The one domain the example connection "owns" and puts behind single sign-on. */
export const EXAMPLE_SSO_REQUIRED_DOMAIN = 'sso-required.example.test'

/** `ServerPlugin.ssoPolicy`: development only, like the pretend IdP the method starts. */
export async function exampleSsoPolicy(
  email: string,
  config: PluginConfig
): Promise<SsoRequirement | null> {
  if (config.APP_ENV !== 'development') return null
  if (!email.toLowerCase().endsWith(`@${EXAMPLE_SSO_REQUIRED_DOMAIN}`)) return null
  return { required: true, methodId: EXAMPLE_SSO_METHOD_ID, label: 'Example SSO' }
}
