/**
 * `scripts/provision/resend.ts` pure helpers (config project, no network): Resend's relative
 * record names become FQDNs in the Cloudflare zone, nothing is proxied, MX keeps its priority,
 * and the zone lookup walks from the most specific candidate up to (but never including) the TLD.
 */
import { describe, expect, it } from 'vitest'
import {
  emailFromFor,
  qualifyRecordName,
  resendRecordsToDns,
  zoneCandidates,
} from '../../scripts/provision/resend'

const DOMAIN = 'mail.app.example.com'

// Shaped like https://resend.com/docs/api-reference/domains/create-domain (fake values).
const RECORDS = [
  {
    record: 'SPF',
    name: 'send',
    type: 'MX',
    ttl: 'Auto',
    status: 'not_started',
    value: 'feedback-smtp.us-east-1.amazonses.com',
    priority: 10,
  },
  {
    record: 'SPF',
    name: 'send',
    type: 'TXT',
    ttl: 'Auto',
    status: 'not_started',
    value: 'v=spf1 include:amazonses.com ~all',
  },
  {
    record: 'DKIM',
    name: 'fakefakefakefakefake._domainkey',
    type: 'TXT',
    ttl: 'Auto',
    status: 'not_started',
    value: 'p=FAKEFAKEFAKE',
  },
  {
    record: 'DKIM',
    name: 'resend._domainkey',
    type: 'CNAME',
    ttl: 'Auto',
    status: 'not_started',
    value: 'resend._domainkey.fake.dkim.amazonses.com',
  },
  {
    record: 'Tracking',
    name: `links.${DOMAIN}`,
    type: 'CNAME',
    ttl: 'Auto',
    status: 'not_started',
    value: 'track.resend.com',
  },
]

describe('resendRecordsToDns', () => {
  const dns = resendRecordsToDns(RECORDS, DOMAIN)

  it('qualifies relative names and keeps already-qualified ones', () => {
    expect(dns.map(r => r.name)).toEqual([
      `send.${DOMAIN}`,
      `send.${DOMAIN}`,
      `fakefakefakefakefake._domainkey.${DOMAIN}`,
      `resend._domainkey.${DOMAIN}`,
      `links.${DOMAIN}`,
    ])
  })
  it('is never proxied and uses ttl 1 (automatic)', () => {
    for (const r of dns) {
      expect(r.proxied).toBe(false)
      expect(r.ttl).toBe(1)
    }
  })
  it('carries MX priority as a number, and TXT/CNAME content verbatim', () => {
    expect(dns[0]).toMatchObject({
      type: 'MX',
      priority: 10,
      content: 'feedback-smtp.us-east-1.amazonses.com',
    })
    expect(dns[1]).toMatchObject({ type: 'TXT', content: 'v=spf1 include:amazonses.com ~all' })
    expect(dns[1].priority).toBeUndefined()
    expect(dns[3]).toMatchObject({
      type: 'CNAME',
      content: 'resend._domainkey.fake.dkim.amazonses.com',
    })
  })
  it('defaults a missing MX priority to 10 and upper-cases the type', () => {
    const [mx] = resendRecordsToDns(
      [{ record: 'SPF', name: 'send', type: 'mx', value: 'x' }],
      DOMAIN
    )
    expect(mx).toMatchObject({ type: 'MX', priority: 10 })
  })
})

describe('qualifyRecordName', () => {
  it('handles apex markers and trailing dots', () => {
    expect(qualifyRecordName('@', DOMAIN)).toBe(DOMAIN)
    expect(qualifyRecordName('', DOMAIN)).toBe(DOMAIN)
    expect(qualifyRecordName(DOMAIN, DOMAIN)).toBe(DOMAIN)
    expect(qualifyRecordName('send.', DOMAIN)).toBe(`send.${DOMAIN}`)
  })
})

describe('zoneCandidates', () => {
  it('walks mail.app.example.co.uk → app.example.co.uk → example.co.uk → co.uk', () => {
    expect(zoneCandidates('mail.app.example.co.uk')).toEqual([
      'mail.app.example.co.uk',
      'app.example.co.uk',
      'example.co.uk',
      'co.uk',
    ])
  })
  it('stops before the TLD for a short domain', () => {
    expect(zoneCandidates('example.com')).toEqual(['example.com'])
    expect(zoneCandidates('Mail.Example.com.')).toEqual(['mail.example.com', 'example.com'])
  })
})

describe('emailFromFor', () => {
  it('formats "<APP_NAME> <noreply@domain>"', () => {
    expect(emailFromFor('Example App', DOMAIN)).toBe(`Example App <noreply@${DOMAIN}>`)
  })
})
