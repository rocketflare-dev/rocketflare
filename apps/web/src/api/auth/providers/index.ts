/**
 * Provider registry (D11). `/auth/methods` and the generic OAuth router both read from here;
 * an id that is not in the registry, or one whose secrets are absent, is a 404.
 */
import { type OAuthProviderName, oauthProviderNameSchema } from '@rocketflare/shared/auth'
import { type AppConfig, isOidcOnly } from '../../../config'
import { googleProvider } from './google'
import { microsoftProvider } from './microsoft'
import { oidcProvider } from './oidc'
import type { ProviderDefinition } from './types'

export const PROVIDERS: Record<OAuthProviderName, ProviderDefinition> = {
  google: googleProvider,
  microsoft: microsoftProvider,
  oidc: oidcProvider,
}

export function getProvider(id: string): ProviderDefinition | null {
  const parsed = oauthProviderNameSchema.safeParse(id)
  return parsed.success ? PROVIDERS[parsed.data] : null
}

/**
 * Providers the login page may offer — their credentials present. Under `AUTH_OIDC_ONLY` that is
 * `oidc` alone: the others are refused at `/auth/:provider`, so offering them would be a lie.
 */
export function configuredProviders(cfg: AppConfig): OAuthProviderName[] {
  const ids = (Object.keys(PROVIDERS) as OAuthProviderName[]).filter(id =>
    PROVIDERS[id].configured(cfg)
  )
  return isOidcOnly(cfg) ? ids.filter(id => id === 'oidc') : ids
}

/** The scopes a flow for `def` requests on this deployment. */
export function scopesOf(def: ProviderDefinition, cfg: AppConfig): string[] {
  return def.scopesFor?.(cfg) ?? def.scopes
}

export { oidcEndSessionUrl } from './oidc'
export type {
  OAuthClient,
  OAuthProfile,
  OAuthTokenSet,
  ProfileContext,
  ProviderDefinition,
} from './types'
