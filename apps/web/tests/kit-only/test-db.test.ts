/**
 * One test database per checkout (`scripts/lib/test-db.mjs`, docs/CONCEPTS.md §4): the name is a
 * pure function of `.env.test`'s database and the checkout's real path, only a local URL naming
 * that database is rewritten, and prune only ever lists databases carrying the checkout label.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyCheckoutDatabase,
  CHECKOUT_ROOT,
  checkoutComment,
  checkoutDatabaseName,
  checkoutHash,
  checkoutPath,
  envTestDatabaseName,
  parseCheckoutComment,
  planPrune,
  rewriteDatabaseUrl,
} from '../../../../scripts/lib/test-db.mjs'

const ENV_TEST = [
  'DATABASE_URL=postgresql://test:test@localhost:5433/myapp_test',
  'APP_DATABASE_URL=postgresql://myapp_app:test_app@localhost:5433/myapp_test',
].join('\n')
const LOCAL = 'postgresql://test:test@localhost:5433/myapp_test'

describe('the per-checkout test database', () => {
  it('hashes the path with SHA-256: a fixed value, whatever Node runs it', () => {
    // Pinned: a change here renames every checkout's database and orphans the old ones.
    expect(checkoutHash('/work/app')).toBe('70467eff')
    expect(checkoutHash('/work/app')).toMatch(/^[0-9a-f]{8}$/)
    expect(checkoutHash('/work/app-2')).not.toBe(checkoutHash('/work/app'))
    expect(checkoutDatabaseName('myapp_test', '/work/app')).toBe('myapp_test_70467eff')
  })

  it("names the checkout from this file's location, never the cwd, through symlinks", () => {
    expect(path.join(CHECKOUT_ROOT, 'apps/web/tests/kit-only')).toBe(realpathSync(__dirname))
    const dir = mkdtempSync(path.join(tmpdir(), 'rf-test-db-'))
    try {
      symlinkSync(CHECKOUT_ROOT, path.join(dir, 'link'))
      expect(checkoutPath(path.join(dir, 'link'))).toBe(checkoutPath(CHECKOUT_ROOT))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads the base name from .env.test's DATABASE_URL", () => {
    expect(envTestDatabaseName(ENV_TEST)).toBe('myapp_test')
    expect(envTestDatabaseName('NODE_ENV=test')).toBeNull()
  })

  it('rewrites only a local URL naming the base database', () => {
    expect(rewriteDatabaseUrl(LOCAL, 'myapp_test', 'myapp_test_ab')).toBe(
      'postgresql://test:test@localhost:5433/myapp_test_ab'
    )
    for (const url of [
      'postgresql://test:test@localhost:5433/other_db',
      'postgresql://o:p@ep-cool-name-123456.eu-central-1.aws.neon.tech/myapp_test',
      'not a url',
    ]) {
      expect(rewriteDatabaseUrl(url, 'myapp_test', 'myapp_test_ab')).toBe(url)
    }
  })

  it('points both test URLs at the checkout database, idempotently', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_URL: LOCAL,
      APP_DATABASE_URL: 'postgresql://myapp_app:test_app@localhost:5433/myapp_test',
    }
    const chosen = applyCheckoutDatabase(env, { root: CHECKOUT_ROOT, envTestText: ENV_TEST })
    const name = checkoutDatabaseName('myapp_test', checkoutPath(CHECKOUT_ROOT))
    expect(chosen).toEqual({ base: 'myapp_test', name, path: checkoutPath(CHECKOUT_ROOT) })
    expect(env.DATABASE_URL).toBe(`postgresql://test:test@localhost:5433/${name}`)
    expect(env.APP_DATABASE_URL).toBe(`postgresql://myapp_app:test_app@localhost:5433/${name}`)
    const again = { ...env }
    expect(applyCheckoutDatabase(again, { envTestText: ENV_TEST })).toEqual(chosen)
    expect(again).toEqual(env)
  })

  it('leaves a remote target and a hand-picked database alone', () => {
    const gate = {
      DATABASE_URL: 'postgresql://o:p@ep-a-1.eu-central-1.aws.neon.tech/myapp_test',
      TEST_DATABASE_BRANCH: 'gate-ab12cd-1',
      TEST_DATABASE_EPHEMERAL: '1',
      APP_DATABASE_URL: '',
    }
    const before = { ...gate }
    expect(applyCheckoutDatabase(gate, { envTestText: ENV_TEST })).toBeNull()
    expect(gate).toEqual(before)
    const picked = { DATABASE_URL: 'postgresql://test:test@localhost:5433/scratch' }
    expect(applyCheckoutDatabase(picked, { envTestText: ENV_TEST })).toBeNull()
    expect(picked.DATABASE_URL).toBe('postgresql://test:test@localhost:5433/scratch')
  })

  it('prunes only labelled databases whose checkout is gone', () => {
    expect(parseCheckoutComment(checkoutComment('/work/app'))).toBe('/work/app')
    expect(parseCheckoutComment('something else')).toBeNull()
    expect(parseCheckoutComment(null)).toBeNull()
    const plan = planPrune(
      [
        { name: 'myapp_test', comment: null },
        { name: 'myapp_test_mcp', comment: 'made by hand' },
        { name: 'myapp_test_aaaaaaaa', comment: checkoutComment('/work/here') },
        { name: 'myapp_test_bbbbbbbb', comment: checkoutComment('/work/gone') },
      ],
      p => p === '/work/here'
    )
    expect(plan).toEqual({
      live: [{ name: 'myapp_test_aaaaaaaa', checkout: '/work/here' }],
      stale: [{ name: 'myapp_test_bbbbbbbb', checkout: '/work/gone' }],
    })
  })
})
