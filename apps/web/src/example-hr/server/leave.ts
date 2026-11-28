/**
 * The domain's queries: plain `(db, tenantId, …)` functions its route, tool, seed and `public.ts`
 * all call. Private to the domain — another domain reaches this data through `../public.ts`.
 */
import type {
  CreateLeaveRequest,
  LeaveRequestListQuery,
} from '@rocketflare/shared/example-hr/index'
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import { exampleLeaveRequests, type LeaveRequestRow } from '../db/schema'

export async function listLeaveRequests(
  db: Database,
  tenantId: string,
  { page, pageSize, status }: LeaveRequestListQuery
): Promise<{ items: LeaveRequestRow[]; total: number }> {
  const where = and(
    eq(exampleLeaveRequests.tenantId, tenantId),
    status ? eq(exampleLeaveRequests.status, status) : undefined
  )
  const [items, total] = await Promise.all([
    db
      .select()
      .from(exampleLeaveRequests)
      .where(where)
      .orderBy(desc(exampleLeaveRequests.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.$count(exampleLeaveRequests, where),
  ])
  return { items, total }
}

export async function getLeaveRequest(
  db: Database,
  tenantId: string,
  id: string
): Promise<LeaveRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(exampleLeaveRequests)
    .where(and(eq(exampleLeaveRequests.tenantId, tenantId), eq(exampleLeaveRequests.id, id)))
    .limit(1)
  return row
}

export async function createLeaveRequest(
  db: Database,
  tenantId: string,
  userId: string,
  input: CreateLeaveRequest
): Promise<LeaveRequestRow> {
  const [row] = await db
    .insert(exampleLeaveRequests)
    .values({ tenantId, userId, ...input })
    .returning()
  if (!row) throw new Error('insert returned no row')
  return row
}

/** Decides a PENDING request; `undefined` when it is not pending (or not this tenant's). */
export async function decideLeaveRequest(
  db: Database,
  tenantId: string,
  id: string,
  decidedByUserId: string,
  status: 'approved' | 'rejected'
): Promise<LeaveRequestRow | undefined> {
  const [row] = await db
    .update(exampleLeaveRequests)
    .set({ status, decidedByUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(exampleLeaveRequests.tenantId, tenantId),
        eq(exampleLeaveRequests.id, id),
        eq(exampleLeaveRequests.status, 'pending')
      )
    )
    .returning()
  return row
}

/** The people among `userIds` on APPROVED leave on `on` (YYYY-MM-DD). */
export async function usersOnLeave(
  db: Database,
  tenantId: string,
  userIds: readonly string[],
  on: string
): Promise<string[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .selectDistinct({ userId: exampleLeaveRequests.userId })
    .from(exampleLeaveRequests)
    .where(
      and(
        eq(exampleLeaveRequests.tenantId, tenantId),
        eq(exampleLeaveRequests.status, 'approved'),
        inArray(exampleLeaveRequests.userId, [...userIds]),
        lte(exampleLeaveRequests.startsOn, on),
        gte(exampleLeaveRequests.endsOn, on)
      )
    )
  return rows.map(r => r.userId)
}

/** Today as YYYY-MM-DD, in UTC — the day a leave check means unless told otherwise. */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
