/**
 * `safetyCheck()`'s rules (`tests/helpers/db-safety.ts`): local Postgres always; a remote database
 * only as a Neon GATE branch under the ephemeral profile, named and bound to the URL. Every
 * refusal is proved here because the suites themselves only ever run the accepting path.
 */
import { describe, expect, it } from 'vitest'
import { checkTestDatabaseEnv, isLocalDatabaseUrl, neonEndpointId } from '../helpers/db-safety'

const LOCAL = 'postgresql://test:test@localhost:5433/rocketflare_test'
const POOLED =
  'postgresql://session_owner:s3cret@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/session_app?sslmode=require'
const DIRECT =
  'postgresql://session_owner:s3cret@ep-cool-darkness-123456.us-east-2.aws.neon.tech/session_app?sslmode=require'

const gate = {
  NODE_ENV: 'test',
  DATABASE_URL: POOLED,
  DATABASE_DRIVER: 'neon',
  TEST_DATABASE_EPHEMERAL: '1',
  TEST_DATABASE_BRANCH: 'gate-51db60f0-1',
  TEST_DATABASE_ENDPOINT: 'ep-cool-darkness-123456',
}

const refuses = (env: Record<string, string | undefined>, why: RegExp) =>
  expect(() => checkTestDatabaseEnv(env)).toThrow(why)

describe('safetyCheck: local Postgres', () => {
  it('accepts a local database under NODE_ENV=test, with or without the ephemeral profile', () => {
    expect(() => checkTestDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL: LOCAL })).not.toThrow()
    expect(() =>
      checkTestDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL: LOCAL, TEST_DATABASE_EPHEMERAL: '1' })
    ).not.toThrow()
    expect(() =>
      checkTestDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@127.0.0.1/x' })
    ).not.toThrow()
  })

  it('refuses without NODE_ENV=test or a DATABASE_URL', () => {
    refuses({ NODE_ENV: 'development', DATABASE_URL: LOCAL }, /NODE_ENV must be 'test'/)
    refuses({ ...gate, NODE_ENV: undefined }, /NODE_ENV must be 'test'/)
    refuses({ NODE_ENV: 'test' }, /DATABASE_URL is not set/)
  })

  it('judges the HOST, not the string: "localhost" in a remote URL is not local', () => {
    expect(isLocalDatabaseUrl('postgresql://u:localhost@db.example.com/localhost')).toBe(false)
    refuses(
      { NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@prod.example.com:5432/localhost_copy' },
      /must be local Postgres/
    )
  })

  it('never prints a credential in a refusal', () => {
    expect(() => checkTestDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL: POOLED })).toThrow(
      /Current host: ep-cool-darkness-123456-pooler/
    )
    expect(() => checkTestDatabaseEnv({ NODE_ENV: 'test', DATABASE_URL: POOLED })).not.toThrow(
      /s3cret/
    )
  })
})

describe('safetyCheck: the ephemeral gate branch', () => {
  it('accepts a named gate branch whose endpoint is in the URL, pooled or direct', () => {
    expect(() => checkTestDatabaseEnv(gate)).not.toThrow()
    expect(() => checkTestDatabaseEnv({ ...gate, DATABASE_URL: DIRECT })).not.toThrow()
    expect(() =>
      checkTestDatabaseEnv({ ...gate, TEST_DATABASE_BRANCH: 'gate-a1-12' })
    ).not.toThrow()
  })

  it('refuses a remote database without the ephemeral profile, whatever else is set', () => {
    refuses({ ...gate, TEST_DATABASE_EPHEMERAL: undefined }, /must be local Postgres/)
    refuses({ ...gate, TEST_DATABASE_EPHEMERAL: 'true' }, /must be local Postgres/)
  })

  it('refuses the postgres driver (a sandbox has no TCP out)', () => {
    refuses({ ...gate, DATABASE_DRIVER: 'postgres' }, /needs DATABASE_DRIVER=neon/)
    refuses({ ...gate, DATABASE_DRIVER: undefined }, /needs DATABASE_DRIVER=neon/)
  })

  it('refuses any remote host that is not a Neon endpoint', () => {
    refuses({ ...gate, DATABASE_URL: 'postgresql://u:p@db.example.com/app' }, /not a Neon endpoint/)
    refuses(
      { ...gate, DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech.evil.com/app' },
      /not a Neon endpoint/
    )
  })

  it('refuses a branch name that is not a gate branch', () => {
    for (const name of [
      undefined,
      '',
      'main',
      'dev',
      'session-51db60f0',
      'gate-51db60f0',
      'gate--1',
      'GATE-ab-1',
      'gate-ab-1 ',
      'gate-ab-1\nmain',
    ]) {
      refuses({ ...gate, TEST_DATABASE_BRANCH: name }, /must name a gate branch/)
    }
  })

  it('refuses when the named endpoint is not the one in the URL (a stale opt-in)', () => {
    refuses({ ...gate, TEST_DATABASE_ENDPOINT: undefined }, /is not the endpoint in DATABASE_URL/)
    refuses({ ...gate, TEST_DATABASE_ENDPOINT: 'ep-other-endpoint-999' }, /is not the endpoint/)
    refuses(
      { ...gate, TEST_DATABASE_ENDPOINT: 'ep-cool-darkness-123456-pooler' },
      /is not the endpoint/
    )
  })

  it('APP_DATABASE_URL: local or the same endpoint, never another database', () => {
    expect(() => checkTestDatabaseEnv({ ...gate, APP_DATABASE_URL: '' })).not.toThrow()
    expect(() => checkTestDatabaseEnv({ ...gate, APP_DATABASE_URL: LOCAL })).not.toThrow()
    expect(() =>
      checkTestDatabaseEnv({
        ...gate,
        APP_DATABASE_URL: DIRECT.replace('session_owner:s3cret', 'rocketflare_app:x'),
      })
    ).not.toThrow()
    refuses(
      { ...gate, APP_DATABASE_URL: 'postgresql://u:p@ep-other-1.us-east-2.aws.neon.tech/app' },
      /APP_DATABASE_URL must be local/
    )
    refuses(
      { NODE_ENV: 'test', DATABASE_URL: LOCAL, APP_DATABASE_URL: POOLED },
      /APP_DATABASE_URL must be local/
    )
  })
})

describe('neonEndpointId', () => {
  it('reads the endpoint id from a pooled or direct Neon host, nothing else', () => {
    expect(neonEndpointId(POOLED)).toBe('ep-cool-darkness-123456')
    expect(neonEndpointId(DIRECT)).toBe('ep-cool-darkness-123456')
    expect(neonEndpointId(LOCAL)).toBeNull()
    expect(neonEndpointId('postgresql://u:p@api.neon.tech/x')).toBeNull()
    expect(neonEndpointId('not a url')).toBeNull()
  })
})
