/**
 * Every unit's shared half — the installed plugins, then the app's own domains — as ONE list. The
 * five composers (`ai/agents.ts`, `jobs.ts`, `permissions.ts`, `features.ts`, `realtime.ts`) read
 * this rather than the plugin barrel, so a domain's job types, agent keys, subjects, flags and
 * realtime roots join the closed sets exactly as a plugin's do.
 *
 * Plugins first, so a collision (which the boundary check refuses) resolves the way it did before
 * domains existed. Like the barrels it reads, this module never imports a composer.
 */
import { SHARED_DOMAINS, sharedDomains } from './app'
import { SHARED_PLUGINS } from './plugins/index'
import type { SharedPlugin } from './plugins/types'

export const SHARED_UNITS = [...SHARED_PLUGINS, ...SHARED_DOMAINS] as const

/** The list widened for iteration; `SHARED_UNITS` is for type derivation. */
export const sharedUnits: readonly SharedPlugin[] = SHARED_UNITS

/** The ids of the app's own domains — what tells a unit's kind apart in the shared half. */
export const sharedDomainIds: ReadonlySet<string> = new Set(sharedDomains.map(d => d.id))
