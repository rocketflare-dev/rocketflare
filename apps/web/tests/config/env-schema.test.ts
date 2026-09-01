import { describe, expect, it } from 'vitest'
import {
  ConfigError,
  configuredOAuthProviders,
  hasEmail,
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
    expect(loadConfig({ ...base, AUTH_SIGNING_KEY: '' }).AUTH_SIGNING_KEY).toBeUndefined()
    expect(() => loadConfig({ ...base, AUTH_SIGNING_KEY: 'short' })).toThrow(/AUTH_SIGNING_KEY/)
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
})
