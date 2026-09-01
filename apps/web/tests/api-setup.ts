/**
 * Per-FILE teardown for the api projects (`tests/setup.ts` is the per-RUN one): end every
 * pooled script handle so a fork's connection count does not climb file after file
 * (`53300 too many clients` is what that looks like). Handles are rebuilt on demand.
 */
import { afterAll } from 'vitest'
import { closeAllDatabases } from '@/db/client'

afterAll(async () => {
  await closeAllDatabases()
})
