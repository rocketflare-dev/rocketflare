/**
 * The paths that answer their own CORS (any origin, never credentials) are recognised with or
 * without one trailing slash, so the credentialed app-wide CORS never answers for one of them.
 */
import { describe, expect, it } from 'vitest'
import { isMcpPath } from '@/api/middleware/cors'

describe('the paths with their own CORS', () => {
  it('are the same path with one trailing slash', () => {
    for (const path of [
      '/mcp',
      '/mcp/t/acme',
      '/oauth/token',
      '/oauth/revoke',
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
    ]) {
      expect(isMcpPath(path), path).toBe(true)
      expect(isMcpPath(`${path}/`), `${path}/`).toBe(true)
    }
  })

  it('leave every other path to the app-wide CORS', () => {
    for (const path of [
      '/',
      '/api/me',
      '/oauth/authorize',
      '/oauth/consent',
      '/mcpx',
      '/oauth/tokens',
    ]) {
      expect(isMcpPath(path), path).toBe(false)
    }
  })
})
