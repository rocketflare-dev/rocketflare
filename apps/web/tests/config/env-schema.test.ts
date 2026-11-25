import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  configuredOAuthProviders,
  hasEmail,
  hasOidc,
  isIdpManaged,
  isOidcOnly,
  loadConfig,
  oauthRedirectUri,
} from '@/config'

const base = {
  APP_ENV: 'development',
  APP_URL: 'http://localhost:3001',
}

describe('loadConfig', () => {
  it('rejects a missing APP_URL and names the key', () => {
    expect(() => loadConfig({ APP_ENV: 'development' })).toThrow(ConfigError)
    expect(() => loadConfig({ APP_ENV: 'development' })).toThrow(/APP_URL/)
  })

  it('rejects bad enum values', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(/APP_ENV/)
    expect(() => loadConfig({ ...base, SIGNUP_MODE: 'anyone' })).toThrow(/SIGNUP_MODE/)
    expect(() => loadConfig({ ...base, TENANT_SCOPE_MODE: 'pin' })).toThrow(/TENANT_SCOPE_MODE/)
  })

  it('accepts the .env.test-shaped environment', () => {
    const cfg = loadConfig(process.env)
    expect(cfg.APP_URL).toBe('http://localhost:3001')
    expect(cfg.LOG_LEVEL).toBe('silent')
    expect(cfg.TENANCY_MODE).toBe('multi')
    expect(cfg.SIGNUP_MODE).toBe('invite_only')
    expect(cfg.TENANT_SCOPE_MODE).toBe('off')
    expect(configuredOAuthProviders(cfg)).toEqual(['google', 'microsoft'])
  })

  it('applies defaults for optional vars', () => {
    const cfg = loadConfig(base)
    expect(cfg.APP_NAME).toBe('Rocketflare')
    expect(cfg.RELEASE_VERSION).toBe('dev')
    expect(cfg.LOG_LEVEL).toBe('info')
    expect(cfg.BOOTSTRAP_ADMIN_EMAILS).toEqual([])
    expect(hasEmail(cfg)).toBe(false)
    expect(configuredOAuthProviders(cfg)).toEqual([])
  })

  it('parses BOOTSTRAP_ADMIN_EMAILS as a lower-cased csv list', () => {
    const cfg = loadConfig({
      ...base,
      BOOTSTRAP_ADMIN_EMAILS: ' Ada@Example.com, bob@example.com ,',
    })
    expect(cfg.BOOTSTRAP_ADMIN_EMAILS).toEqual(['ada@example.com', 'bob@example.com'])
    expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAILS: 'not-an-email' })).toThrow(
      /BOOTSTRAP_ADMIN_EMAILS/
    )
  })

  it('treats empty-string secrets as unset and enforces minimum key lengths', () => {
    expect(loadConfig({ ...base, RESEND_API_KEY: '' }).RESEND_API_KEY).toBeUndefined()
    expect(loadConfig({ ...base, OAUTH_ENCRYPTION_KEY: '' }).OAUTH_ENCRYPTION_KEY).toBeUndefined()
    expect(() => loadConfig({ ...base, OAUTH_ENCRYPTION_KEY: 'short' })).toThrow(
      /OAUTH_ENCRYPTION_KEY/
    )
  })

  it('memoises per env object identity', () => {
    const env = { ...base }
    const first = loadConfig(env)
    expect(loadConfig(env)).toBe(first)
    expect(loadConfig({ ...base })).not.toBe(first)
  })

  it('derives OAuth redirect URIs from APP_URL', () => {
    const cfg = loadConfig({ ...base, APP_URL: 'https://app.example.com' })
    expect(oauthRedirectUri(cfg, 'google')).toBe('https://app.example.com/auth/google/callback')
  })

  it('OIDC: off unless issuer + client id; defaults for label and scopes', () => {
    const off = loadConfig({ ...base, OIDC_ISSUER: '', OIDC_CLIENT_ID: '' })
    expect(hasOidc(off)).toBe(false)
    expect(off.OIDC_LABEL).toBe('Single sign-on')
    expect(off.OIDC_SCOPES).toBe('openid email profile')
    expect(off.AUTH_OIDC_ONLY).toBe(false)
    expect(off.OIDC_TRUST_EMAIL).toBe(false)
    expect(loadConfig({ ...base, OIDC_TRUST_EMAIL: 'true' }).OIDC_TRUST_EMAIL).toBe(true)
    expect(hasOidc(loadConfig({ ...base, OIDC_ISSUER: 'https://idp.test' }))).toBe(false)
    const on = loadConfig({ ...base, OIDC_ISSUER: 'https://idp.test', OIDC_CLIENT_ID: 'app' })
    expect(hasOidc(on)).toBe(true)
    expect(isOidcOnly(on)).toBe(false)
    expect(configuredOAuthProviders(on)).toEqual(['oidc'])
    expect(oauthRedirectUri(on, 'oidc')).toBe('http://localhost:3001/auth/oidc/callback')
    expect(() => loadConfig({ ...base, OIDC_ISSUER: 'not a url' })).toThrow(/OIDC_ISSUER/)
  })

  it('AUTH_OIDC_ONLY=true without an issuer and client id is a config error', () => {
    expect(() => loadConfig({ ...base, AUTH_OIDC_ONLY: 'true' })).toThrow(/AUTH_OIDC_ONLY/)
    expect(() =>
      loadConfig({ ...base, AUTH_OIDC_ONLY: 'true', OIDC_ISSUER: 'https://idp.test' })
    ).toThrow(ConfigError)
    const cfg = loadConfig({
      ...base,
      AUTH_OIDC_ONLY: 'true',
      OIDC_ISSUER: 'https://idp.test',
      OIDC_CLIENT_ID: 'app',
    })
    expect(isOidcOnly(cfg)).toBe(true)
  })

  it('OIDC_MANAGED_TENANCY needs an issuer, a client id and multi-tenancy', () => {
    const issuer = { OIDC_ISSUER: 'https://idp.test', OIDC_CLIENT_ID: 'app' }
    expect(loadConfig({ ...base, OIDC_MANAGED_TENANCY: '' }).OIDC_MANAGED_TENANCY).toBe(false)
    expect(() => loadConfig({ ...base, OIDC_MANAGED_TENANCY: 'true' })).toThrow(
      /OIDC_MANAGED_TENANCY/
    )
    expect(() =>
      loadConfig({ ...base, OIDC_MANAGED_TENANCY: 'true', OIDC_ISSUER: 'https://idp.test' })
    ).toThrow(ConfigError)
    expect(() =>
      loadConfig({ ...base, ...issuer, OIDC_MANAGED_TENANCY: 'true', TENANCY_MODE: 'single' })
    ).toThrow(/TENANCY_MODE=multi/)
    expect(isIdpManaged(loadConfig({ ...base, ...issuer, OIDC_MANAGED_TENANCY: 'true' }))).toBe(
      true
    )
    expect(isIdpManaged(loadConfig({ ...base, ...issuer }))).toBe(false)
  })

  it('OIDC_ROLE_MAP parses issuerRole:admin|member pairs and refuses anything else', () => {
    expect(loadConfig(base).OIDC_ROLE_MAP).toEqual({ admin: 'admin', member: 'member' })
    expect(
      loadConfig({ ...base, OIDC_ROLE_MAP: ' org_admin:admin , org_member:member ' }).OIDC_ROLE_MAP
    ).toEqual({ org_admin: 'admin', org_member: 'member' })
    expect(() => loadConfig({ ...base, OIDC_ROLE_MAP: 'boss:owner' })).toThrow(/OIDC_ROLE_MAP/)
    expect(() => loadConfig({ ...base, OIDC_ROLE_MAP: 'nocolon' })).toThrow(/OIDC_ROLE_MAP/)
  })

  it('OIDC_SESSION_MAX_AGE_DAYS is 1 to 30 days, 7 by default', () => {
    expect(loadConfig(base).OIDC_SESSION_MAX_AGE_DAYS).toBe(7)
    expect(loadConfig({ ...base, OIDC_SESSION_MAX_AGE_DAYS: '30' }).OIDC_SESSION_MAX_AGE_DAYS).toBe(
      30
    )
    expect(() => loadConfig({ ...base, OIDC_SESSION_MAX_AGE_DAYS: '31' })).toThrow(
      /OIDC_SESSION_MAX_AGE_DAYS/
    )
  })

  it('IDENTITY_WEBHOOK_SECRET must be a Standard Webhooks secret', () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`
    expect(loadConfig({ ...base, IDENTITY_WEBHOOK_SECRET: secret }).IDENTITY_WEBHOOK_SECRET).toBe(
      secret
    )
    expect(() => loadConfig({ ...base, IDENTITY_WEBHOOK_SECRET: 'hunter2' })).toThrow(
      /IDENTITY_WEBHOOK_SECRET/
    )
  })
})
