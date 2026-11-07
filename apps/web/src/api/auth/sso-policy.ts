/**
 * "SSO required" per email domain. Core cannot know which domains an organisation has put behind
 * single sign-on — the connections, and the DNS proof that a domain is theirs, live in a plugin —
 * so it ASKS: every installed plugin's `ServerPlugin.ssoPolicy(db, email, { config })` answers
 * `{ required: true, methodId }` ("my connection claims this domain; send them to my login method
 * `methodId`") or `null`.
 *
 * Pure over the plugin list, like `plugin-login-methods.ts`: the routes pass the barrel,
 * `tests/config/plugins.test.ts` passes a fixture. Called once per sign-in ATTEMPT — the magic-link
 * request and verify, the OAuth/OIDC callback, dev login and a plugin's `identityFor().signIn` —
 * never per request: a session, once minted, is trusted until it ends.
 *
 * The decisions, each a security property:
 *
 * - **A policy that throws FAILS CLOSED for that email** (logged at `error`). A claim the plugin
 *   could not answer is treated as a claim with no known method: the kit's own methods are refused
 *   with `sso_required`, the plugin's own sign-in still works. Failing open would let anyone who
 *   can make the policy throw (a malformed address, a slow database) take the magic-link door
 *   past an organisation that closed it. The lock-out is bounded by the break-glass below.
 * - **Break-glass: `BOOTSTRAP_ADMIN_EMAILS` are exempt.** Those addresses are written in the
 *   deployment's config, which only an operator can change, so a misconfigured or broken
 *   connection can never lock the operator out of the console that would fix it. The policy is
 *   still evaluated for them, and a bypassed claim is logged at `warn`. Nothing else is exempt —
 *   not `is_global_admin` (a database flag, which the connection's own tenancy could grant).
 * - **Only a CLAIMING plugin's sign-in is exempt.** `identityFor(c, id).signIn` passes when `id`
 *   is one of the plugins that claimed the email; a different plugin's IdP asserting the same
 *   address is refused like the kit's own methods, so a second tenant's connection cannot
 *   sidestep the first's requirement.
 * - **`methodId` is checked** against the claiming plugin's own `loginMethods(cfg)`; one it does
 *   not declare keeps the requirement and drops the hint (logged), so the login page never routes
 *   a person to a button that does not exist.
 */
import type { AppConfig } from '../../config'
import type { Database } from '../../db/client'
import { isBootstrapAdmin } from '../services/auth'
import type { Logger } from '../utils/core/logger'
import { type PluginLoginMethodDeclaration, pluginLoginMethods } from './plugin-login-methods'

/** What a plugin's `ssoPolicy` answers for an email whose domain one of its connections claims. */
export interface SsoRequirement {
  required: true
  /** One of the plugin's OWN `loginMethods(cfg)` ids (not namespaced): where to send the person. */
  methodId: string
  /** The connection's display name ("Acme SSO") — used in the "use single sign-on" email and logs. */
  label?: string
}

export type SsoPolicy = (
  db: Database,
  email: string,
  ctx: { config: AppConfig }
) => Promise<SsoRequirement | null>

interface SsoPolicySource {
  shared: { id: string }
  ssoPolicy?: SsoPolicy
  loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]
}

/** One plugin's claim on the email. */
export interface SsoClaim {
  pluginId: string
  /** `<plugin id>:<method id>` as `GET /auth/methods` names it, or null when unknown. */
  method: string | null
  label?: string
  /** The policy threw (or answered something malformed): fail-closed, not a real answer. */
  failed?: true
}

export type SsoDecision =
  | { required: false; bypassed?: 'bootstrap_admin' }
  | { required: true; claims: SsoClaim[]; method: string | null; label?: string }

export const NOT_REQUIRED: SsoDecision = { required: false }

type SsoLogger = Pick<Logger, 'warn' | 'error'>

function isRequirement(value: unknown): value is SsoRequirement {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { required?: unknown }).required === true &&
    typeof (value as { methodId?: unknown }).methodId === 'string'
  )
}

async function claimOf(
  plugin: SsoPolicySource & { ssoPolicy: SsoPolicy },
  db: Database,
  cfg: AppConfig,
  email: string,
  logger?: SsoLogger
): Promise<SsoClaim | null> {
  const pluginId = plugin.shared.id
  let answer: unknown
  try {
    answer = await plugin.ssoPolicy(db, email, { config: cfg })
  } catch (err) {
    logger?.error({ err, plugin: pluginId }, 'ssoPolicy threw; failing closed for this email')
    return { pluginId, method: null, failed: true }
  }
  if (answer === null || answer === undefined) return null
  if (!isRequirement(answer)) {
    logger?.error({ plugin: pluginId }, 'ssoPolicy answered neither null nor a requirement')
    return { pluginId, method: null, failed: true }
  }
  const method = `${pluginId}:${answer.methodId}`
  const offered = pluginLoginMethods([plugin], cfg, logger).some(m => m.id === method)
  if (!offered) {
    logger?.warn(
      { plugin: pluginId, methodId: answer.methodId },
      'ssoPolicy named a login method the plugin does not offer; requirement kept, hint dropped'
    )
  }
  return {
    pluginId,
    method: offered ? method : null,
    ...(answer.label ? { label: answer.label } : {}),
  }
}

/**
 * Ask every installed plugin whether `email` must sign in through single sign-on. Plugins are
 * asked in parallel; the routing hint is the first claim (barrel order) that has a method.
 */
export async function evaluateSsoPolicy(
  plugins: readonly SsoPolicySource[],
  db: Database,
  cfg: AppConfig,
  email: string,
  logger?: SsoLogger
): Promise<SsoDecision> {
  const asking = plugins.filter(
    (p): p is SsoPolicySource & { ssoPolicy: SsoPolicy } => typeof p.ssoPolicy === 'function'
  )
  if (asking.length === 0) return NOT_REQUIRED
  const normalised = email.trim().toLowerCase()
  const claims = (
    await Promise.all(asking.map(p => claimOf(p, db, cfg, normalised, logger)))
  ).filter((c): c is SsoClaim => c !== null)
  if (claims.length === 0) return NOT_REQUIRED
  if (isBootstrapAdmin(cfg, normalised)) {
    logger?.warn(
      { plugins: claims.map(c => c.pluginId) },
      'SSO required for a BOOTSTRAP_ADMIN_EMAILS address: bypassed (break-glass)'
    )
    return { required: false, bypassed: 'bootstrap_admin' }
  }
  const routed = claims.find(c => c.method !== null)
  return {
    required: true,
    claims,
    method: routed?.method ?? null,
    ...(routed?.label ? { label: routed.label } : {}),
  }
}

/** Every distinct address of the sign-in (the asserted one, the account's), evaluated once each. */
export async function evaluateSsoPolicyForAll(
  plugins: readonly SsoPolicySource[],
  db: Database,
  cfg: AppConfig,
  emails: readonly (string | null | undefined)[],
  logger?: SsoLogger
): Promise<SsoDecision> {
  const distinct = [
    ...new Set(emails.filter((e): e is string => Boolean(e)).map(e => e.trim().toLowerCase())),
  ]
  const decisions = await Promise.all(
    distinct.map(e => evaluateSsoPolicy(plugins, db, cfg, e, logger))
  )
  const required = decisions.filter(
    (d): d is Extract<SsoDecision, { required: true }> => d.required
  )
  if (required.length === 0) return decisions[0] ?? NOT_REQUIRED
  const claims = required.flatMap(d => d.claims)
  const routed = required.find(d => d.method !== null)
  return {
    required: true,
    claims,
    method: routed?.method ?? null,
    ...(routed?.label ? { label: routed.label } : {}),
  }
}

/**
 * May this sign-in proceed? `core` is every kit method (magic link, Google, Microsoft, OIDC, dev
 * login); `{ pluginId }` is that plugin's `identityFor().signIn`, which passes only when that
 * plugin is one of the claimers.
 */
export function ssoAllows(decision: SsoDecision, via: 'core' | { pluginId: string }): boolean {
  if (!decision.required) return true
  if (via === 'core') return false
  return decision.claims.some(c => c.pluginId === via.pluginId)
}

/**
 * `/login?error=sso_required[&method=<plugin id>:<method id>][&returnUrl=…][&email=…]`. The label
 * is never put in the URL: anyone can craft a login URL, so the page shows the label of the method
 * it looked up in `GET /auth/methods`, never text from the query string.
 */
export function ssoRequiredLoginPath(
  decision: SsoDecision,
  extra: { returnUrl?: string | null; email?: string | null } = {}
): string {
  const params = new URLSearchParams({ error: 'sso_required' })
  if (decision.required && decision.method) params.set('method', decision.method)
  if (extra.returnUrl && extra.returnUrl !== '/') params.set('returnUrl', extra.returnUrl)
  if (extra.email) params.set('email', extra.email)
  return `/login?${params.toString()}`
}
