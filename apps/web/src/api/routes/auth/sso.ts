/**
 * The "SSO required" check as the kit's sign-in routes run it: the plugin barrel bound into
 * `evaluateSsoPolicyForAll` (`api/auth/sso-policy.ts`, pure over the list). Its own module because
 * it reads `plugins/server`: `routes/auth/helpers.ts` is imported by `plugins/api/identity.ts`,
 * and a plugin-facing module that names the barrel statically closes the cycle
 * `plugins/api → plugins/server → <plugin>/index → plugins/api`. `identity.ts` reaches this one
 * through a function-scope `await import(...)` instead.
 */
import type { AppConfig } from '../../../config'
import type { Database } from '../../../db/client'
import { serverPlugins } from '../../../plugins/server'
import { evaluateSsoPolicyForAll, type SsoDecision } from '../../auth/sso-policy'
import type { Logger } from '../../utils/core/logger'

export function ssoDecisionFor(
  db: Database,
  cfg: AppConfig,
  emails: readonly (string | null | undefined)[],
  logger?: Pick<Logger, 'warn' | 'error'>
): Promise<SsoDecision> {
  return evaluateSsoPolicyForAll(serverPlugins, db, cfg, emails, logger)
}
