/**
 * `scripts/provision/redact.ts` — the one redaction seam of the provisioning tooling (config
 * project). Fixture values are obviously fake and low-entropy on purpose.
 */
import { describe, expect, it } from 'vitest'
import { redact, safeJson } from '../../scripts/provision/redact'

const HEX64 = 'deadbeef'.repeat(8) // 64 hex — an OAUTH_ENCRYPTION_KEY shape
const HEX32 = 'abcdef12'.repeat(4) // 32 hex — a Hyperdrive / KV id, must survive

describe('redact', () => {
  it('masks postgres URLs, host included', () => {
    expect(
      redact('url=postgresql://user:fakepw@ep-fake.us-east-1.aws.neon.tech/db?sslmode=require done')
    ).toBe('url=<redacted> done')
    expect(redact('postgres://a:b@localhost:5432/x')).toBe('<redacted>')
  })
  it('masks Resend and Neon API keys', () => {
    expect(redact('key re_FAKEFAKE_fakefakefakefake rest')).toBe('key <redacted> rest')
    expect(redact('NEON napi_fakefakefakefakefake')).toBe('NEON <redacted>')
  })
  it('masks 40+ hex secrets but keeps 32-hex resource ids readable', () => {
    expect(redact(`OAUTH=${HEX64}`)).toBe('OAUTH=<redacted>')
    expect(redact(`id = "${HEX32}"`)).toBe(`id = "${HEX32}"`)
  })
  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer fakeTOKENfakeTOKEN123 end')).toBe(
      'Authorization: Bearer <redacted> end'
    )
    expect(redact('CLOUDFLARE_API_TOKEN=fakeTOKENfakeTOKEN123')).toBe(
      'CLOUDFLARE_API_TOKEN=<redacted>'
    )
  })
  it('leaves plain text untouched', () => {
    const plain =
      'hyperdrive rocketflare-staging exists id=abcdef12abcdef12abcdef12abcdef12 — mail.example.com'
    expect(redact(plain)).toBe(plain)
    expect(redact('re_ short')).toBe('re_ short')
  })
})

describe('safeJson', () => {
  it('sanitises Neon fields and then redacts the text', () => {
    const out = safeJson({
      roles: [{ name: 'owner', password: 'fakepw' }],
      note: `postgresql://o:fakepw@ep-fake.neon.tech/db`,
      id: HEX32,
    })
    expect(out).not.toContain('fakepw')
    expect(out).toContain('<redacted>')
    expect(out).toContain(HEX32)
  })
})
