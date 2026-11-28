/**
 * `example-hr`'s ONE public door. Another domain imports this file and nothing else under
 * `apps/web/src/example-hr/`, and only if it lists `example-hr` in its `dependsOn`
 * (docs/CONCEPTS.md §20). The boundary check fails any other import.
 *
 * What may be exported here: types, zod contracts, and functions that take the CALLER's injected
 * context — so the caller's tenant and CASL rules apply, and HR's own rules (who may read leave)
 * are enforced here, by the domain that owns them, rather than re-implemented by every reader.
 * Nothing exported holds module state or opens a database handle of its own.
 *
 * Events are the preferred coupling for "something happened" (`example-hr.leave.approved`); this
 * file is for synchronous reads and commands.
 */
import { EXAMPLE_LEAVE_SUBJECT } from '@rocketflare/shared/example-hr/index'
import type { AbilityCheck, Database } from '@/plugins/api'
import { ForbiddenError } from '@/plugins/api'
import { today, usersOnLeave } from './server/leave'

export type { LeaveApprovedPayload, LeaveRequest } from '@rocketflare/shared/example-hr/index'

/** What a caller hands over: its own handle, tenant and ability — a route's or a tool's context. */
export interface HrCaller {
  db: Database
  tenantId: string
  can: AbilityCheck
}

/**
 * Which of `userIds` are on approved leave on `on` (default today). Anyone who may READ leave
 * requests may ask; a caller without that grant gets a 403, not an empty answer.
 */
export async function whoIsOnLeave(
  ctx: HrCaller,
  userIds: readonly string[],
  on: string = today()
): Promise<string[]> {
  if (!ctx.can('read', EXAMPLE_LEAVE_SUBJECT)) {
    throw new ForbiddenError('You may not read leave requests', 'example_hr_forbidden')
  }
  return usersOnLeave(ctx.db, ctx.tenantId, userIds, on)
}
