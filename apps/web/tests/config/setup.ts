/**
 * Per-file setup for both `config` projects: the same network guard as the api projects
 * (`helpers/network-guard.ts`), so a config test that stubs `fetch` and misses a call fails at once
 * instead of reaching the internet. The shared project adds `shared-setup.ts` after this.
 *
 * `config` shares a module registry, and Vitest restores spies after each file but not stubs:
 * undo a file's `vi.stubGlobal` / `vi.stubEnv` when it ends, so the next file starts clean.
 */
import { afterAll, vi } from 'vitest'
import { installNetworkGuard } from '../helpers/network-guard'

installNetworkGuard()

afterAll(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
