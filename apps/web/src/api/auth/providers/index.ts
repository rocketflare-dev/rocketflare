/**
 * Provider registry (D11). `/auth/methods` and the generic OAuth router both read from here;
 * an id that is not in the registry, or one whose secrets are absent, is a 404.
 */
import { type OAuthProviderName, oauthProviderNameSchema } from '@gmgo/shared/auth'
import type { AppConfig } from '../../../config'
import { googleProvider } from './google'
import { microsoftProvider } from './microsoft'
import type { ProviderDefinition } from './types'

export const PROVIDERS: Record<OAuthProviderName, ProviderDefinition> = {
  google: googleProvider,
  microsoft: microsoftProvider,
}

export function getProvider(id: string): ProviderDefinition | null {
  const parsed = oauthProviderNameSchema.safeParse(id)
  return parsed.success ? PROVIDERS[parsed.data] : null
}

/** Providers the login page may offer — both client id and secret present. */
export function configuredProviders(cfg: AppConfig): OAuthProviderName[] {
  return (Object.keys(PROVIDERS) as OAuthProviderName[]).filter(id => PROVIDERS[id].configured(cfg))
}

export type { OAuthClient, OAuthProfile, OAuthTokenSet, ProviderDefinition } from './types'
