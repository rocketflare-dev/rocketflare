/**
 * How a Bearer API key's auth context is told apart from a cookie session: its session id is
 * `api-key:<keyId>`. A leaf module (types only), so route helpers can ask without loading the
 * auth middleware — which reaches the plugin barrel — at module scope.
 */
import type { AuthContext } from '../types'

export const API_KEY_SESSION_PREFIX = 'api-key:'

export function isApiKeySession(auth: Pick<AuthContext, 'session'>): boolean {
  return auth.session.id.startsWith(API_KEY_SESSION_PREFIX)
}
