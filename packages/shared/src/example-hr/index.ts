/**
 * `example-hr` — an example APP DOMAIN, shared half: leave requests and their approval.
 *
 * A domain is where an app's own concepts live (docs/CONCEPTS.md §20). This one and `example-sales`
 * exist to be read and then deleted or copied: `example-sales` depends on this one, so between them
 * they show a cross-domain `public.ts` call, a declared event another domain handles, and an agent
 * using both domains' tools in one run.
 *
 * Everything it keys carries the id `example-hr` — the job and event types, the API prefix
 * `/api/example-hr`, the query-key roots — exactly like a plugin. Its table is `example_leave_requests`:
 * every example shares the `example_` namespace, and the boundary check still refuses two of them
 * declaring one name.
 *
 * Like a plugin's shared entry, this module never imports a composer at runtime.
 */
import { z } from 'zod'
import type { FeatureDefinition } from '../features'
import { paginatedResponse, paginationQuerySchema } from '../pagination'
import type { SharedDomain } from '../plugins/types'

export const EXAMPLE_HR_ID = 'example-hr'

/** Gates the nav item, the page, the mount and the tool. `pnpm seed` turns it on for the seeded tenant. */
export const EXAMPLE_HR_FLAG = 'example-hr'

/** The CASL subject a leave request is governed by. */
export const EXAMPLE_LEAVE_SUBJECT = 'ExampleLeaveRequest'

/** Emitted once when a request is approved; `example-sales` reassigns the person's open leads. */
export const EXAMPLE_LEAVE_APPROVED_EVENT = 'example-hr.leave.approved'

/** The platform knowledge collection only HR (whoever may manage leave requests) searches. */
export const EXAMPLE_HR_POLICY_SOURCE = 'example-hr:policies'

/** The realtime entity a leave-request change nudges — also the UI's query-key root. */
export const EXAMPLE_HR_LEAVE_ENTITY = 'example-hr:leave-requests'

/**
 * HR's availability tool, named here so another domain's agent can find it in `ctx.tools` — the
 * tool itself stays private to `example-hr`.
 */
export const EXAMPLE_HR_AVAILABILITY_TOOL = 'example_hr_availability'

export const EXAMPLE_LEAVE_REASON_MAX = 500

export const leaveStatusSchema = z.enum(['pending', 'approved', 'rejected'])
export type LeaveStatus = z.infer<typeof leaveStatusSchema>

/** `YYYY-MM-DD`: a leave request is days, not instants. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const leaveRequestSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  reason: z.string(),
  status: leaveStatusSchema,
  decidedByUserId: z.string().uuid().nullable(),
  decidedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})
export type LeaveRequest = z.infer<typeof leaveRequestSchema>

export const leaveRequestListResponseSchema = paginatedResponse(leaveRequestSchema)
export type LeaveRequestListResponse = z.infer<typeof leaveRequestListResponseSchema>

export const leaveRequestListQuerySchema = paginationQuerySchema.extend({
  status: leaveStatusSchema.optional(),
})
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>

export const createLeaveRequestSchema = z
  .object({
    startsOn: isoDateSchema,
    endsOn: isoDateSchema,
    reason: z.string().trim().max(EXAMPLE_LEAVE_REASON_MAX).default(''),
  })
  .refine(r => r.endsOn >= r.startsOn, { message: 'endsOn is before startsOn', path: ['endsOn'] })
export type CreateLeaveRequest = z.infer<typeof createLeaveRequestSchema>

export const decideLeaveRequestSchema = z.object({ decision: z.enum(['approve', 'reject']) })
export type DecideLeaveRequest = z.infer<typeof decideLeaveRequestSchema>

/** The event's payload: ids and dates only — a subscriber reads anything else under its own tenant. */
export const leaveApprovedPayloadSchema = z.object({
  leaveRequestId: z.string().uuid(),
  userId: z.string().uuid(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
})
export type LeaveApprovedPayload = z.infer<typeof leaveApprovedPayloadSchema>

export const exampleHrShared = {
  id: EXAMPLE_HR_ID,
  label: 'HR (example)',
  subjects: [EXAMPLE_LEAVE_SUBJECT],
  events: { [EXAMPLE_LEAVE_APPROVED_EVENT]: leaveApprovedPayloadSchema },
  features: {
    [EXAMPLE_HR_FLAG]: {
      label: 'HR (example domain)',
      description:
        'The example HR domain: leave requests, their approval and an HR-only policy collection. ' +
        'Gates its nav item, page, /api/example-hr mount and tool. Safe to delete.',
      defaultState: 'off',
      defaultRolloutUnit: 'tenant',
      environmentGated: false,
    } satisfies FeatureDefinition,
  },
} as const satisfies SharedDomain
