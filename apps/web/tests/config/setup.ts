/**
 * Per-file setup for both `config` projects: the same network guard as the api projects
 * (`helpers/network-guard.ts`), so a config test that stubs `fetch` and misses a call fails at once
 * instead of reaching the internet. The shared project adds `shared-setup.ts` after this.
 */
import { installNetworkGuard } from '../helpers/network-guard'

installNetworkGuard()
