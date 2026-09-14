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
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import {
  analyticsPageGroups,
  analyticsPages,
  documentGroups,
  documents,
  groups,
  groupTypes,
} from '../../db/schema'
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
 * `EXISTS (select 1 from <junction> where <resource fk> = <resource id> and group_id = any($ids))`.
 * Built once here so both resources cannot drift, and so the empty-scope case degrades to `false`
 * rather than to an `in ()` Postgres refuses.
 */
function sharedWithMyGroups(scope: AccessScope, exists: SQL): SQL {
  return scope.groupIds.length === 0 ? sql`false` : exists
}

export function visibleDocuments(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${documents.ownerUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(
    scope,
    sql`exists (
      select 1 from ${documentGroups}
      where ${documentGroups.documentId} = ${documents.id}
        and ${inArray(documentGroups.groupId, scope.groupIds)}
    )`
  )
  return sql`(${documents.visibility} = 'tenant' or ${owned} or ${shared})`
}

export function visibleAnalyticsPages(scope: AccessScope): SQL | undefined {
  if (scope.bypass) return undefined
  const owned = scope.userId ? sql`${analyticsPages.createdByUserId} = ${scope.userId}` : sql`false`
  const shared = sharedWithMyGroups(
    scope,
    sql`exists (
      select 1 from ${analyticsPageGroups}
      where ${analyticsPageGroups.pageId} = ${analyticsPages.id}
        and ${inArray(analyticsPageGroups.groupId, scope.groupIds)}
    )`
  )
  return sql`(${analyticsPages.visibility} = 'tenant' or ${owned} or ${shared})`
}

/**
 * The same predicate expressed over `chunks`' parent document, for the two halves of hybrid
 * search. `searchChunks` already joins `documents`, so this costs no extra join.
 */
export function visibleDocumentsForChunks(scope: AccessScope): SQL | undefined {
  return visibleDocuments(scope)
}

// ---- Writing visibility ------------------------------------------------------------------------

export type VisibilityResource = 'document' | 'analytics-page'

export interface SetResourceGroupsInput {
  visibility: ResourceVisibility
  groupIds: readonly string[]
}

/**
 * Replace a resource's visibility and its grants in ONE transaction. Every group id is checked
 * against the tenant first (`assertGroupsInTenant`), so a grant can never name another
 * organisation's group. `visibility: 'tenant'` clears the grants — leaving stale rows behind would
 * silently re-restrict the resource the next time somebody flipped it back.
 */
export async function setResourceGroups(
  db: Database,
  scope: Pick<AccessScope, 'tenantId'>,
  kind: VisibilityResource,
  resourceId: string,
  input: SetResourceGroupsInput
): Promise<string[]> {
  const groupIds =
    input.visibility === 'groups'
      ? await assertGroupsInTenant(db, scope.tenantId, input.groupIds)
      : []
  await db.transaction(async tx => {
    if (kind === 'document') {
      await tx
        .update(documents)
        .set({ visibility: input.visibility })
        .where(and(eq(documents.id, resourceId), eq(documents.tenantId, scope.tenantId)))
      await tx
        .delete(documentGroups)
        .where(
          and(
            eq(documentGroups.tenantId, scope.tenantId),
            eq(documentGroups.documentId, resourceId)
          )
        )
      if (groupIds.length > 0) {
        await tx
          .insert(documentGroups)
          .values(
            groupIds.map(groupId => ({ tenantId: scope.tenantId, documentId: resourceId, groupId }))
          )
          .onConflictDoNothing()
      }
    } else {
      await tx
        .update(analyticsPages)
        .set({ visibility: input.visibility })
        .where(and(eq(analyticsPages.id, resourceId), eq(analyticsPages.tenantId, scope.tenantId)))
      await tx
        .delete(analyticsPageGroups)
        .where(
          and(
            eq(analyticsPageGroups.tenantId, scope.tenantId),
            eq(analyticsPageGroups.pageId, resourceId)
          )
        )
      if (groupIds.length > 0) {
        await tx
          .insert(analyticsPageGroups)
          .values(
            groupIds.map(groupId => ({ tenantId: scope.tenantId, pageId: resourceId, groupId }))
          )
          .onConflictDoNothing()
      }
    }
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
  kind: VisibilityResource,
  resourceIds: string[]
): Promise<Map<string, GroupRef[]>> {
  const out = new Map<string, GroupRef[]>()
  if (resourceIds.length === 0) return out
  const rows =
    kind === 'document'
      ? await db
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
            and(
              eq(documentGroups.tenantId, tenantId),
              inArray(documentGroups.documentId, resourceIds)
            )
          )
      : await db
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
          )
  for (const row of rows) {
    const list = out.get(row.resourceId) ?? []
    list.push({ id: row.id, name: row.name, typeName: row.typeName })
    out.set(row.resourceId, list)
  }
  return out
}
