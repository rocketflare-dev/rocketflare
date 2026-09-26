/** Per-file teardown: end every pooled handle so connection counts do not climb file after file. */
import { afterAll } from 'vitest'
import { closeAllDatabases } from '@/db/client'

afterAll(async () => {
  await closeAllDatabases()
})
