/**
 * Setup for the `api-fixtures` project only, which runs BEFORE `api-setup.ts`: installs the
 * fixture agents (`helpers/fixture-agents.ts`) into the REAL plugin barrels, in place, before
 * anything that derives from them at module load is imported — the agent-key enum
 * (`z.enum(AGENT_KEYS)`), the `AGENTS` and prompt registries, the job handler table.
 *
 * The project shares one module registry per worker, so this runs once per FILE but installs once
 * per WORKER: the barrels it changed stay cached, and every file in the project sees the same app
 * — the kit's plugins plus the fixture one. That is why the fixture agents live in a project of
 * their own and not in `api`, whose files see the app as it ships.
 *
 * The shared barrel first, and alone: nothing in its graph reads the composed agent keys, so the
 * fixture is in `sharedPlugins` before the server barrel's graph builds `z.enum(AGENT_KEYS)`.
 * Nothing in the server barrel's graph reads `serverPlugins` at module scope either (it would find
 * the barrel uninitialised), so its push is early enough for `AGENTS`, the prompts and the jobs.
 */
import type { SharedPlugin } from '@rocketflare/shared/plugins'
import type { AnyServerPlugin } from '@/plugins/server'
import { fixtureServer, fixtureShared } from './helpers/fixture-agents'

// Dynamic, and in this order: a static import is hoisted above the push, and the server barrel's
// graph evaluates the agent-key enum from the shared barrel as it stands at that moment.
const { sharedPlugins } = await import('@rocketflare/shared/plugins')
const shared = sharedPlugins as SharedPlugin[]
if (!shared.includes(fixtureShared)) shared.push(fixtureShared)

const { serverPlugins } = await import('@/plugins/server')
const server = serverPlugins as AnyServerPlugin[]
if (!server.includes(fixtureServer)) server.push(fixtureServer)
