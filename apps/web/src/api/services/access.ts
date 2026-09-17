/**
 * Resource visibility (D29) — the ONE place "who may read this row" is expressed as SQL.
 *
 * The kit never uses CASL conditions: an ability answers "may this role do this KIND of thing",
 * and "is this particular row yours" is always a predicate in the query. Groups follow that rule
 * exactly — `visibleDocuments(scope)` returns a `SQL` fragment that is **ANDed with the tenant
 * predicate and never replaces it**, and an installed plugin contributes its own the same way
 * through `ServerPlugin.visibilityResources` (D31; the analytics plugin's dashboards are one).
 *
 * The predicate reads: the resource is tenant-wide, OR the reader owns it, OR the reader is in one
 * of the groups it was shared with. `bypass` (admin, owner, support, global admin) drops the
 * predicate entirely — support included, deliberately: it is `isAdminLevel` everywhere else and it
 * is a visible membership row the customer can see.
 *
 * The one asymmetry worth naming: an EMPTY grant list under `visibility: 'groups'` matches nobody,
 * so a resource whose last group was deleted becomes owner-and-admins-only rather than public.
 */
import type { GroupRef, ResourceVisibility } from '@rocketflare/shared/groups'
import { and, count, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { documentGroups, documents, groups, groupTypes } from '../../db/schema'
import { serverPlugins } from '../../plugins/server'
import { isAdminLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import { ForbiddenError } from '../utils/core/errors'
import { type AccessScope, sharedWithMyGroups } from './access-sql'
import { assertGroupsInTenant, listUserGroups } from './groups'

/**
 * Everything a visibility predicate needs. `userId` is null for work with no requesting person (a
 * system agent run): such a reader sees tenant-visible resources only, never an owner's private
 * ones.
 */
export function accessScopeOf(auth: AuthContext): AccessScope {
  if (!auth.tenantId) throw new Error('accessScopeOf: no tenant in the auth context')
  return {
    tenantId: auth.tenantId,
    userId: auth.user.id,
    groupIds: auth.groups.map(g => g.id),
    bypass: isAdminLevel(auth),
  }
}

/** The scope an agent run or a background job gets for a person (or for nobody). */
export async function accessScopeForUser(
  db: Database,
  tenantId: string,
  userId: string | null,
  options: { bypass?: boolean } = {}
): Promise<AccessScope> {
  const groupIds = userId ? (await listUserGroups(db, tenantId, userId)).map(g => g.id) : []
  return { tenantId, userId, groupIds, bypass: options.bypass ?? false }
}

/** A scope that sees everything in the tenant — for maintenance paths, never for a request. */
export function fullAccessScope(tenantId: string): AccessScope {
  return { tenantId, userId: null, groupIds: [], bypass: true }
}

export function visibleDocuments(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${documents.ownerUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(scope, 'document_groups', 'document_id', sql`${documents.id}`)
  return sql`(${documents.visibility} = 'tenant' or ${owned} or ${shared})`
}

// ---- The registry of restrictable resources (D29, D31) -----------------------------------------

export interface SetResourceGroupsInput {
  visibility: ResourceVisibility
  groupIds: readonly string[]
}

/** One row of `grantsForResources`, before it is grouped by resource. */
export interface ResourceGrantRow {
  resourceId: string
  id: string
  name: string
  typeName: string
}

/**
 * What it takes to be a resource a group can restrict.
 *
 * This was a two-value union and an `if (kind === 'document')` in three places. A plugin (D31) may
 * own restrictable rows of its own, and the host cannot know its tables — so the four behaviours
 * became a registry entry the owner supplies, rather than metadata the host interprets. Behaviour,
 * not columns, is deliberate: drizzle's types only hold for a concrete table, and a registry of
 * generic `PgTable`s would have to cast away exactly the checking that makes these queries safe.
 *
 * The rules a new entry must keep are the kit's existing ones: `predicate` is ANDed with the tenant
 * predicate and NEVER replaces it, it returns `undefined` for an admin-level scope, and
 * `visibility` is a COLUMN — an empty grant list under `groups` means owner-and-admins-only, never
 * "everyone".
 */
export interface VisibilityResource {
  /** `document`; `<id>:<thing>` for a plugin (`analytics:page`). */
  key: string
  /** Singular noun for the 409 that says what deleting a group would narrow. */
  noun: string
  /** Key this resource's count takes in `GroupUsage` and in the 409 `details`. */
  usageKey: string
  /** The SQL predicate, ANDed with the tenant predicate. `undefined` = no narrowing. */
  predicate: (scope: AccessScope) => SQL | undefined
  /** Set the row's `visibility` and replace its grants, inside the caller's transaction. */
  setGroups: (
    tx: Database,
    tenantId: string,
    resourceId: string,
    input: SetResourceGroupsInput,
    groupIds: readonly string[]
  ) => Promise<void>
  /** Which groups these resources are shared with. */
  grantRows: (db: Database, tenantId: string, resourceIds: string[]) => Promise<ResourceGrantRow[]>
  /** How many grants these groups still hold over this resource. */
  countGrants: (db: Database, tenantId: string, groupIds: string[]) => Promise<number>
}

const documentVisibility: VisibilityResource = {
  key: 'document',
  noun: 'document',
  usageKey: 'documents',
  predicate: visibleDocuments,
  setGroups: async (tx, tenantId, resourceId, input, groupIds) => {
    await tx
      .update(documents)
      .set({ visibility: input.visibility })
      .where(and(eq(documents.id, resourceId), eq(documents.tenantId, tenantId)))
    await tx
      .delete(documentGroups)
      .where(and(eq(documentGroups.tenantId, tenantId), eq(documentGroups.documentId, resourceId)))
    if (groupIds.length > 0) {
      await tx
        .insert(documentGroups)
        .values(groupIds.map(groupId => ({ tenantId, documentId: resourceId, groupId })))
        .onConflictDoNothing()
    }
  },
  grantRows: (db, tenantId, resourceIds) =>
    db
      .select({
        resourceId: documentGroups.documentId,
        id: groups.id,
        name: groups.name,
        typeName: groupTypes.name,
      })
      .from(documentGroups)
      .innerJoin(groups, eq(groups.id, documentGroups.groupId))
      .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
      .where(
        and(eq(documentGroups.tenantId, tenantId), inArray(documentGroups.documentId, resourceIds))
      ),
  countGrants: async (db, tenantId, groupIds) => {
    const [row] = await db
      .select({ n: count() })
      .from(documentGroups)
      .where(and(eq(documentGroups.tenantId, tenantId), inArray(documentGroups.groupId, groupIds)))
    return row?.n ?? 0
  },
}

export const CORE_VISIBILITY_RESOURCES: readonly VisibilityResource[] = [documentVisibility]

/**
 * The kit's restrictable resources plus every installed plugin's (D31).
 *
 * **A function, memoised — not a const.** A plugin's visibility resource sits in a module that
 * imports this one (for `sharedWithMyGroups`, for typed route helpers, for anything), so this
 * module and the plugin barrel are in a cycle whichever way round the app is entered. Evaluated at
 * module scope, `serverPlugins` is `undefined` for whichever side loses the race, and the failure
 * is `undefined.flatMap` at IMPORT time — the Worker never starts, and which entry point triggers
 * it depends on nothing a reader can see. Read at CALL time, live bindings make it always defined.
 * The memo is what keeps `countGroupGrants` from re-walking every plugin per request.
 */
let visibilityResourcesMemo: readonly VisibilityResource[] | null = null

export function visibilityResources(): readonly VisibilityResource[] {
  if (visibilityResourcesMemo === null) {
    visibilityResourcesMemo = [
      ...CORE_VISIBILITY_RESOURCES,
      ...serverPlugins.flatMap(p => p.visibilityResources ?? []),
    ]
  }
  return visibilityResourcesMemo
}

/**
 * `kind` is a plain string rather than a union, because a plugin's keys are not knowable here. An
 * unknown one throws: a silent no-op would leave a resource that looks restricted and is not.
 */
export function visibilityResourceFor(kind: string): VisibilityResource {
  const found = visibilityResources().find(r => r.key === kind)
  if (!found) throw new Error(`visibilityResourceFor: no visibility resource named '${kind}'`)
  return found
}

/**
 * One count per restrictable resource, keyed by its `usageKey` (`documents`, `dashboards`, and
 * whatever an installed plugin registers). Every key is always present, including the zeroes: the
 * 409 quotes the whole picture, and a missing key would read as "none of those" rather than "none
 * counted".
 */
export type GroupUsage = Record<string, number>

/** What a group still grants, across every registered visibility resource. */
export async function countGroupGrants(
  db: Database,
  tenantId: string,
  groupIds: string[]
): Promise<GroupUsage> {
  const usage: GroupUsage = {}
  const resources = visibilityResources()
  for (const resource of resources) usage[resource.usageKey] = 0
  if (groupIds.length === 0) return usage
  const counts = await Promise.all(resources.map(r => r.countGrants(db, tenantId, groupIds)))
  resources.forEach((r, i) => {
    usage[r.usageKey] = counts[i] ?? 0
  })
  return usage
}

// ---- Writing visibility ------------------------------------------------------------------------

/**
 * Replace a resource's visibility and its grants in ONE transaction. Every group id is checked
 * against the tenant first (`assertGroupsInTenant`), so a grant can never name another
 * organisation's group. `visibility: 'tenant'` clears the grants — leaving stale rows behind would
 * silently re-restrict the resource the next time somebody flipped it back.
 */
export async function setResourceGroups(
  db: Database,
  scope: Pick<AccessScope, 'tenantId'>,
  kind: string,
  resourceId: string,
  input: SetResourceGroupsInput
): Promise<string[]> {
  const resource = visibilityResourceFor(kind)
  const groupIds =
    input.visibility === 'groups'
      ? await assertGroupsInTenant(db, scope.tenantId, input.groupIds)
      : []
  await db.transaction(async tx => {
    await resource.setGroups(tx as unknown as Database, scope.tenantId, resourceId, input, groupIds)
  })
  return groupIds
}

/**
 * What a CLIENT may ask for. Admin-level callers may share with any group in the tenant; a plain
 * member may share only with groups they are in — otherwise "restrict to Finance" is a way to hide
 * a document from yourself, and to discover which groups exist. Absent input keeps the default,
 * which is tenant-wide.
 */
export async function resolveRequestedVisibility(
  db: Database,
  scope: AccessScope,
  input: { visibility?: ResourceVisibility; groupIds?: readonly string[] } | undefined
): Promise<SetResourceGroupsInput> {
  const visibility = input?.visibility ?? 'tenant'
  if (visibility === 'tenant') return { visibility, groupIds: [] }
  const groupIds = await assertGroupsInTenant(db, scope.tenantId, input?.groupIds ?? [])
  if (!scope.bypass) {
    const mine = new Set(scope.groupIds)
    const outside = groupIds.filter(id => !mine.has(id))
    if (outside.length > 0) {
      throw new ForbiddenError('You can only share with groups you belong to', 'group_not_yours', {
        groupIds: outside,
      })
    }
  }
  return { visibility, groupIds }
}

// ---- Reading grants back -------------------------------------------------------------------------

/**
 * The groups each of these resources is shared with, in one query. Used to decorate a list, so
 * the badge strip on a documents page costs one extra round trip rather than one per row.
 */
export async function grantsForResources(
  db: Database,
  tenantId: string,
  kind: string,
  resourceIds: string[]
): Promise<Map<string, GroupRef[]>> {
  const out = new Map<string, GroupRef[]>()
  if (resourceIds.length === 0) return out
  const rows = await visibilityResourceFor(kind).grantRows(db, tenantId, resourceIds)
  for (const row of rows) {
    const list = out.get(row.resourceId) ?? []
    list.push({ id: row.id, name: row.name, typeName: row.typeName })
    out.set(row.resourceId, list)
  }
  return out
}

/**
 * Re-exported so every existing importer of `services/access` is unchanged. The definitions now
 * live in the LEAF `./access-sql`, because this module reads the plugin barrel: anything an
 * installed plugin needs at module scope has to come from a file that does not (D31).
 */
export { type AccessScope, sharedWithMyGroups } from './access-sql'
