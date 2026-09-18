/**
 * The two escape hatches that read the WHOLE installed set (D31).
 *
 * Everything else in this surface hands a plugin what it needs. These two hand it what every OTHER
 * plugin contributed, and what every plugin's tables add up to — which is a different kind of
 * thing, so they live in their own file rather than on a context, and the barrel does not
 * re-export them. Importing this module is a deliberate act, and it should read like one.
 *
 * **Both are FUNCTIONS, and that is not a style choice.** This module reads
 * `apps/web/src/plugins/server.ts`, which imports every installed plugin, which imports this
 * module — a cycle, whichever way round the app is entered. Evaluated at MODULE scope, one side
 * finds `serverPlugins` still `undefined`, and the failure is `undefined.flatMap` at IMPORT time:
 * the Worker never starts, and which entry point loses the race depends on nothing a reader can
 * see. Read at CALL time, live bindings make it always defined. The kit learned this extracting
 * analytics (`docs/CONCEPTS.md` §16, "What Phase C measured") and `services/access.ts` carries the
 * same note.
 */

import * as schema from '../../db/schema'
import { serverPlugins } from '../server'

/**
 * Everything every installed plugin contributed under one `extensions` key (D31, decision 6).
 *
 * This is how one plugin offers a registry other plugins fill: the analytics plugin reads
 * `extensions('cubes')` and gets the cubes every other installed plugin declared. The kit stays
 * ignorant of what anybody means by a cube, which is the point — `readonly unknown[]` at the
 * boundary.
 *
 * **The owning plugin narrows with zod and fails loudly.** An unparseable contribution must be an
 * error naming the plugin, not a silently dropped entry: a cube that does not appear is a
 * dashboard that renders empty, and nothing anywhere says why.
 */
export function extensions(key: string): readonly unknown[] {
  return serverPlugins.flatMap(p => p.extensions?.[key] ?? [])
}

/** Which plugins contributed under a key — for the error message when one of them fails to parse. */
export function extensionSources(key: string): readonly string[] {
  return serverPlugins.filter(p => (p.extensions?.[key]?.length ?? 0) > 0).map(p => p.shared.id)
}

/** The merged drizzle schema: every kit table AND every installed plugin's. */
export type AllTables = typeof schema

/**
 * The whole schema namespace, for a library that takes one (drizzle-cube's `createCubeApp({ schema
 * })` is the case this exists for).
 *
 * **Know what you are taking on.** This is not "your tables"; it is every table in the
 * application, the kit's and every other installed plugin's, and its shape therefore changes when
 * somebody installs a plugin you have never heard of. Anything built from it must tolerate tables
 * appearing and disappearing, and must not assume a name it did not declare itself. For a plugin's
 * own tables, import them from its own schema directory instead — that is a fixed, reviewable set.
 *
 * It is also the widest thing in this surface: a query built over it is a query with no tenant
 * predicate unless the caller adds one, and no registry can add one for you.
 */
export function allTables(): AllTables {
  return schema
}
