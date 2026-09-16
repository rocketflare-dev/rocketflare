/**
 * Resource visibility (D29) — the ONE place "who may read this row" is expressed as SQL.
 *
 * The kit never uses CASL conditions: an ability answers "may this role do this KIND of thing",
 * and "is this particular row yours" is always a predicate in the query. Groups follow that rule
 * exactly — `visibleDocuments(scope)` and `visibleAnalyticsPages(scope)` return a `SQL` fragment
 * that is **ANDed with the tenant predicate and never replaces it**.
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
import {
  analyticsPageGroups,
  analyticsPages,
  documentGroups,
  documents,
  groups,
  groupTypes,
} from '../../db/schema'
import { serverPlugins } from '../../plugins/server'
import { isAdminLevel } from '../middleware/permissions'
import type { AuthContext } from '../types'
import { ForbiddenError } from '../utils/core/errors'
import { assertGroupsInTenant, listUserGroups } from './groups'

/**
 * Everything a visibility predicate needs. `userId` is null for work with no requesting person (a
 * system agent run): such a reader sees tenant-visible resources only, never an owner's private
 * ones.
 */
export interface AccessScope {
  tenantId: string
  userId: string | null
  groupIds: string[]
  /** Admin-level readers see every row in the tenant. */
  bypass: boolean
}

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

/**
 * `exists (select 1 from <junction> j where j.<fk> = <resource>.id and j.group_id = any($ids))`.
 *
 * The subquery is written with a LITERAL alias and raw column names rather than drizzle column
 * objects. That is not stylistic: drizzle renders a column object with whatever table alias is in
 * scope where the fragment is spliced, so `${documentGroups.documentId}` inside a query over
 * `documents` comes out as `"documents"."document_id"` — a column that does not exist, and a 500
 * rather than a wrong answer. The alias here is local to the subquery and cannot be captured.
 *
 * The ids go in as one bound parameter each — never interpolated, and never as a single array
 * parameter, whose type Postgres cannot infer inside a subquery.
 */
function sharedWithMyGroups(
  scope: AccessScope,
  junction: string,
  foreignKey: string,
  resourceId: SQL
): SQL {
  if (scope.groupIds.length === 0) return sql`false`
  const ids = sql.join(
    scope.groupIds.map(id => sql`${id}`),
    sql`, `
  )
  return sql`exists (select 1 from ${sql.raw(`"${junction}" j`)} where ${sql.raw(`j."${foreignKey}"`)} = ${resourceId} and ${sql.raw(`j."group_id"`)} in (${ids}))`
}

export function visibleDocuments(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${documents.ownerUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(scope, 'document_groups', 'document_id', sql`${documents.id}`)
  return sql`(${documents.visibility} = 'tenant' or ${owned} or ${shared})`
}

export function visibleAnalyticsPages(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${analyticsPages.createdByUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(
    scope,
    'analytics_page_groups',
    'page_id',
    sql`${analyticsPages.id}`
  )
  return sql`(${analyticsPages.visibility} = 'tenant' or ${owned} or ${shared})`
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
  /** `document`, `analytics-page`; `<id>:<thing>` for a plugin. */
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

const analyticsPageVisibility: VisibilityResource = {
  key: 'analytics-page',
  noun: 'dashboard',
  usageKey: 'dashboards',
  predicate: visibleAnalyticsPages,
  setGroups: async (tx, tenantId, resourceId, input, groupIds) => {
    await tx
      .update(analyticsPages)
      .set({ visibility: input.visibility })
      .where(and(eq(analyticsPages.id, resourceId), eq(analyticsPages.tenantId, tenantId)))
    await tx
      .delete(analyticsPageGroups)
      .where(
        and(eq(analyticsPageGroups.tenantId, tenantId), eq(analyticsPageGroups.pageId, resourceId))
      )
    if (groupIds.length > 0) {
      await tx
        .insert(analyticsPageGroups)
        .values(groupIds.map(groupId => ({ tenantId, pageId: resourceId, groupId })))
        .onConflictDoNothing()
    }
  },
  grantRows: (db, tenantId, resourceIds) =>
    db
      .select({
        resourceId: analyticsPageGroups.pageId,
        id: groups.id,
        name: groups.name,
        typeName: groupTypes.name,
      })
      .from(analyticsPageGroups)
      .innerJoin(groups, eq(groups.id, analyticsPageGroups.groupId))
      .innerJoin(groupTypes, eq(groupTypes.id, groups.groupTypeId))
      .where(
        and(
          eq(analyticsPageGroups.tenantId, tenantId),
          inArray(analyticsPageGroups.pageId, resourceIds)
        )
      ),
  countGrants: async (db, tenantId, groupIds) => {
    const [row] = await db
      .select({ n: count() })
      .from(analyticsPageGroups)
      .where(
        and(
          eq(analyticsPageGroups.tenantId, tenantId),
          inArray(analyticsPageGroups.groupId, groupIds)
        )
      )
    return row?.n ?? 0
  },
}

export const CORE_VISIBILITY_RESOURCES: readonly VisibilityResource[] = [
  documentVisibility,
  analyticsPageVisibility,
]

/** The kit's restrictable resources plus every installed plugin's (D31). */
export const VISIBILITY_RESOURCES: readonly VisibilityResource[] = [
  ...CORE_VISIBILITY_RESOURCES,
  ...serverPlugins.flatMap(p => p.visibilityResources ?? []),
]

/**
 * `kind` is a plain string rather than a union, because a plugin's keys are not knowable here. An
 * unknown one throws: a silent no-op would leave a resource that looks restricted and is not.
 */
export function visibilityResourceFor(kind: string): VisibilityResource {
  const found = VISIBILITY_RESOURCES.find(r => r.key === kind)
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
  for (const resource of VISIBILITY_RESOURCES) usage[resource.usageKey] = 0
  if (groupIds.length === 0) return usage
  const counts = await Promise.all(
    VISIBILITY_RESOURCES.map(r => r.countGrants(db, tenantId, groupIds))
  )
  VISIBILITY_RESOURCES.forEach((r, i) => {
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
