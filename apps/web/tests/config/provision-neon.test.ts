/**
 * `scripts/provision/neon.ts` pure helpers (config project, no network): the connection URL
 * always targets the DIRECT host with `sslmode=require`, the endpoint picker never uses a
 * pooler/proxy host, and the sanitiser strips every credential field from a Neon payload.
 */
import { describe, expect, it } from 'vitest'
import { toDirectNeonHost } from '../../scripts/migrate'
import {
  buildConnectionUrl,
  pickDatabase,
  pickEndpoint,
  pickRole,
} from '../../scripts/provision/neon'
import { redact, sanitizeNeon } from '../../scripts/provision/redact'

const DIRECT = 'ep-fake-example-000000.us-east-1.aws.neon.tech'
const POOLER = 'ep-fake-example-000000-pooler.us-east-1.aws.neon.tech'

describe('buildConnectionUrl', () => {
  it('builds postgresql://role:pw@direct-host/db?sslmode=require', () => {
    const url = buildConnectionUrl({
      role: 'app_owner',
      password: 'fake-pw',
      host: DIRECT,
      database: 'appdb',
    })
    expect(url).toBe(`postgresql://app_owner:fake-pw@${DIRECT}/appdb?sslmode=require`)
  })
  it('rewrites a -pooler host to the direct host and encodes the password', () => {
    const url = buildConnectionUrl({
      role: 'r',
      password: 'p@ss/w:rd',
      host: POOLER,
      database: 'd',
    })
    expect(url).toBe(`postgresql://r:p%40ss%2Fw%3Ard@${DIRECT}/d?sslmode=require`)
    expect(new URL(url).password).toBe('p%40ss%2Fw%3Ard')
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/w:rd')
  })
  it('round-trips through toDirectNeonHost (a direct host is unchanged)', () => {
    expect(toDirectNeonHost(POOLER)).toBe(DIRECT)
    expect(toDirectNeonHost(DIRECT)).toBe(DIRECT)
    const url = buildConnectionUrl({ role: 'r', password: 'p', host: DIRECT, database: 'd' })
    expect(toDirectNeonHost(url)).toBe(url)
  })
})

describe('pickEndpoint', () => {
  it('takes the read_write endpoint host, never a proxy/pooler host', () => {
    const ep = pickEndpoint([
      { id: 'ep-ro', host: 'ep-ro.us-east-1.aws.neon.tech', type: 'read_only', branch_id: 'br-1' },
      {
        id: 'ep-rw',
        host: DIRECT,
        type: 'read_write',
        branch_id: 'br-1',
        proxy_host: 'proxy.neon.tech',
      },
    ])
    expect(ep).toEqual({ id: 'ep-rw', host: DIRECT })
  })
  it('normalises a pooler-shaped host and ignores a pooler_host-like field if one ever appears', () => {
    const ep = pickEndpoint([
      {
        id: 'ep-rw',
        host: POOLER,
        type: 'read_write',
        branch_id: 'br-1',
        ...({ pooler_host: 'x-pooler.neon.tech' } as object),
      },
    ])
    expect(ep.host).toBe(DIRECT)
  })
  it('throws on an empty list', () => {
    expect(() => pickEndpoint([])).toThrow(/no compute endpoint/)
  })
})

describe('pickDatabase / pickRole', () => {
  it('prefers the project database over `postgres` and the owner role over protected ones', () => {
    expect(
      pickDatabase([
        { name: 'postgres', owner_name: 'neondb_owner' },
        { name: 'neondb', owner_name: 'neondb_owner' },
      ]).name
    ).toBe('neondb')
    expect(
      pickRole([{ name: 'cloud_admin', protected: true }, { name: 'neondb_owner' }], 'neondb_owner')
    ).toBe('neondb_owner')
    expect(pickRole([{ name: 'cloud_admin', protected: true }, { name: 'other' }])).toBe('other')
  })
})

describe('sanitizeNeon', () => {
  it('strips connection_uris, roles[].password and role.password, keeps everything else', () => {
    const payload = {
      project: { id: 'fake-project-000000', name: 'app' },
      connection_uris: [
        {
          connection_uri: `postgresql://r:fakepw@${DIRECT}/d`,
          connection_parameters: { password: 'fakepw' },
        },
      ],
      roles: [{ name: 'neondb_owner', password: 'fakepw', protected: false }],
      role: { name: 'neondb_owner', password: 'fakepw' },
      operations: [{ id: 'op', status: 'finished' }],
    }
    const clean = sanitizeNeon(payload) as any
    expect(clean.connection_uris).toBeUndefined()
    expect(clean.roles[0]).toEqual({ name: 'neondb_owner', protected: false })
    expect(clean.role).toEqual({ name: 'neondb_owner' })
    expect(clean.project).toEqual(payload.project)
    expect(clean.operations).toEqual(payload.operations)
    expect(JSON.stringify(clean)).not.toContain('fakepw')
    // The original is not mutated.
    expect(payload.roles[0].password).toBe('fakepw')
  })
  it('a sanitised-then-redacted debug line carries no URL even if one slipped through', () => {
    expect(redact(JSON.stringify({ x: `postgresql://r:fakepw@${DIRECT}/d` }))).toBe(
      '{"x":"<redacted>"}'
    )
  })
})
