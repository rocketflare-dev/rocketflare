/**
 * `scripts/provision/cloudflare-dns.ts` pure helpers (config project, no network): which answers
 * preflight must resolve to a Cloudflare zone, and the one sentence it fails with when a domain is
 * not on the account. `provision.ts` itself runs `main()` on import, so only the helper module is
 * imported here.
 */
import { describe, expect, it } from 'vitest'
import {
  hostsNeedingZone,
  missingZoneHint,
  WORKERS_DEV,
} from '../../scripts/provision/cloudflare-dns'

describe('hostsNeedingZone', () => {
  it('needs nothing for workers.dev hosts with email skipped', () => {
    expect(
      hostsNeedingZone({ hosts: { staging: WORKERS_DEV, production: WORKERS_DEV } }, true)
    ).toEqual([])
    expect(
      hostsNeedingZone(
        { hosts: { staging: WORKERS_DEV, production: WORKERS_DEV }, domain: undefined },
        true
      )
    ).toEqual([])
  })
  it('lists every custom host, then the sending domain, deduplicated and lower-cased', () => {
    expect(
      hostsNeedingZone(
        {
          hosts: { staging: 'Staging.Example.com', production: 'app.example.com' },
          domain: 'Mail.Example.com.',
        },
        false
      )
    ).toEqual(['staging.example.com', 'app.example.com', 'mail.example.com'])
    expect(
      hostsNeedingZone(
        {
          hosts: { staging: 'app.example.com', production: 'app.example.com' },
          domain: 'app.example.com',
        },
        false
      )
    ).toEqual(['app.example.com'])
  })
  it('excludes a cached sending domain when email is skipped, keeps custom hosts', () => {
    expect(
      hostsNeedingZone(
        {
          hosts: { staging: WORKERS_DEV, production: 'app.example.com' },
          domain: 'mail.example.com',
        },
        true
      )
    ).toEqual(['app.example.com'])
    expect(
      hostsNeedingZone(
        { hosts: { staging: WORKERS_DEV, production: WORKERS_DEV }, domain: 'mail.example.com' },
        false
      )
    ).toEqual(['mail.example.com'])
  })
})

describe('missingZoneHint', () => {
  it('is the exact sentence preflight, email create and urls fail with', () => {
    expect(missingZoneHint('example.com')).toBe(
      'the domain example.com is not on this Cloudflare account. Add it first — register it at https://dash.cloudflare.com/?to=/:account/domains/register or add the site and move its nameservers (https://dash.cloudflare.com/?to=/:account/add-site) — or use workers.dev for the hosts and --skip-email.'
    )
  })
})
