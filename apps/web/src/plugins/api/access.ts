/**
 * Row visibility for a plugin's own rows (D29, D31).
 *
 * The kit's rule is unchanged and is the whole of this file: **an ability answers "may this ROLE do
 * this KIND of thing", and "may this reader see this ROW" is always a SQL predicate ANDed with the
 * tenant predicate.** CASL conditions are used nowhere in this kit, and a plugin inventing them
 * would be the only place they appear.
 *
 * Three things a plugin adding a restrictable resource must keep, each of which has a failure mode:
 *
 * - **`predicate` is ANDed with the tenant predicate and never replaces it.** Replacing it is a
 *   cross-tenant read that passes every visibility test you would think to write.
 * - **`visibility` is a COLUMN, and an empty grant list under `'groups'` means owner-and-admins
 *   only.** Inferring "restricted" from "has grant rows" — which is what the application this was
 *   ported from did — turns deleting the last group into a silent publish to the whole
 *   organisation.
 * - **A row the reader may not see answers the SAME 404 as one that does not exist**, or the API
 *   is an existence oracle.
 *
 * `sharedWithMyGroups` comes from `services/access-sql.ts`, the LEAF half of the access module,
 * and not from `services/access.ts`, which composes the registry by reading the plugin barrel. That
 * split exists for this import: a plugin's visibility resource needs the SQL at module scope, and
 * taking it from the composing module resolves the cycle with `serverPlugins` still `undefined` —
 * `undefined.flatMap` at IMPORT time, which takes the Worker down rather than failing one request
 * (measured in Phase C; `docs/CONCEPTS.md` §16).
 */

import { sharedWithMyGroups } from '../../api/services/access-sql'

export type {
  ResourceGrantRow,
  SetResourceGroupsInput,
  VisibilityResource,
} from '../../api/services/access'
export type { AccessScope } from '../../api/services/access-sql'

/**
 * `exists (select 1 from <junction> j where j.<fk> = <resource>.id and j.group_id = any($ids))`.
 *
 * Build a plugin's `predicate` from this rather than writing the subquery: it takes the junction
 * table and foreign key as STRINGS on purpose, because drizzle renders a column object with
 * whatever table alias is in scope where the fragment lands — `${myGroups.thingId}` spliced into a
 * query over `things` comes out as `"things"."thing_id"`, a column that does not exist, and a 500
 * rather than a wrong answer.
 */
export { sharedWithMyGroups }
