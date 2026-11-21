/**
 * A startup failure — no `.env.test` loaded (so no `DATABASE_URL`), a migration Postgres refuses,
 * the database down — printed as itself. Rethrown as is, vitest maps its stack through Vite's
 * module runner, which crashed with `TypeError: code.charCodeAt is not a function` and hid the
 * real error (and printed "No test files found"). So the message, the Postgres fields and the
 * cause chain go to stderr first, read without touching `.stack`, and the error rethrown carries
 * a stack set as plain text, which nothing has to map. Used by `tests/setup.ts` (the api
 * projects' globalSetup); unit-tested in `tests/config/startup-error.test.ts`.
 */
export function plainStartupError(
  error: unknown,
  write: (text: string) => void = text => process.stderr.write(text)
): never {
  const lines: string[] = []
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const e = current as { name?: unknown; message?: unknown; code?: unknown; detail?: unknown }
    const name = typeof e.name === 'string' ? e.name : 'Error'
    const message = typeof e.message === 'string' ? e.message : String(current)
    lines.push(`${depth === 0 ? '' : 'caused by: '}${name}: ${message}`)
    if (typeof e.code === 'string') lines.push(`  code: ${e.code}`)
    if (typeof e.detail === 'string') lines.push(`  detail: ${e.detail}`)
    current = (current as { cause?: unknown }).cause
  }
  const hint =
    'Test database setup failed (tests/setup.ts). Run the suite through `pnpm test` or a ' +
    '`pnpm web test:*` script — they load apps/web/.env.test — and check the database is up ' +
    '(`pnpm web test:db:up`).'
  const text = [hint, ...lines].join('\n')
  write(`\n✖ ${text}\n\n`)
  const plain = new Error(text)
  plain.stack = text
  throw plain
}
