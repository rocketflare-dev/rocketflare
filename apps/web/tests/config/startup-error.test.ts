/**
 * A test-database startup failure is printed as itself, not as Vite's source-map crash
 * (`TypeError: code.charCodeAt is not a function`), which hid a missing `.env.test` and a failing
 * migration behind "No test files found". `plainStartupError` is what `tests/setup.ts` runs on one.
 */
import { describe, expect, it } from 'vitest'
import { plainStartupError } from '../helpers/startup-error'

function caught(error: unknown) {
  const written: string[] = []
  try {
    plainStartupError(error, text => written.push(text))
  } catch (thrown) {
    return { thrown: thrown as Error, written: written.join('') }
  }
  throw new Error('plainStartupError returned')
}

describe('plainStartupError', () => {
  it('prints the original message and rethrows with a plain-text stack nothing maps', () => {
    const { thrown, written } = caught(new Error('SAFETY CHECK FAILED: DATABASE_URL is not set'))
    expect(written).toContain('Error: SAFETY CHECK FAILED: DATABASE_URL is not set')
    expect(written).toContain('.env.test')
    expect(thrown.stack).toBe(thrown.message)
    expect(thrown.stack).not.toMatch(/\n\s+at /)
  })

  it("carries a Postgres error's code and detail, and the cause chain", () => {
    const pg = Object.assign(
      new Error('there is no unique constraint matching given keys for referenced table "x"'),
      { name: 'PostgresError', code: '42830', detail: 'migration 0038' }
    )
    const { written } = caught(new Error('migration failed', { cause: pg }))
    expect(written).toContain('Error: migration failed')
    expect(written).toContain('caused by: PostgresError: there is no unique constraint')
    expect(written).toContain('code: 42830')
    expect(written).toContain('detail: migration 0038')
  })

  it('reads a thrown non-Error too', () => {
    expect(caught('boom').written).toContain('Error: boom')
  })
})
