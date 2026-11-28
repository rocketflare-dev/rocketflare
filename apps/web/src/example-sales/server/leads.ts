/** The domain's queries — private; another domain would reach leads through a `public.ts`. */
import type { CreateLead, LeadListQuery, LeadStatus } from '@rocketflare/shared/example-sales/index'
import { and, desc, eq, ne } from 'drizzle-orm'
import type { Database } from '@/plugins/api'
import { exampleLeads, type LeadRow } from '../db/schema'

export async function listLeads(
  db: Database,
  tenantId: string,
  { page, pageSize }: LeadListQuery
): Promise<{ items: LeadRow[]; total: number }> {
  const where = eq(exampleLeads.tenantId, tenantId)
  const [items, total] = await Promise.all([
    db
      .select()
      .from(exampleLeads)
      .where(where)
      .orderBy(desc(exampleLeads.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.$count(exampleLeads, where),
  ])
  return { items, total }
}

export async function getLead(
  db: Database,
  tenantId: string,
  id: string
): Promise<LeadRow | undefined> {
  const [row] = await db
    .select()
    .from(exampleLeads)
    .where(and(eq(exampleLeads.tenantId, tenantId), eq(exampleLeads.id, id)))
    .limit(1)
  return row
}

export async function createLead(
  db: Database,
  tenantId: string,
  ownerUserId: string | null,
  input: CreateLead
): Promise<LeadRow> {
  const [row] = await db
    .insert(exampleLeads)
    .values({ tenantId, ownerUserId, ...input })
    .returning()
  if (!row) throw new Error('insert returned no row')
  return row
}

export async function setLeadOwner(
  db: Database,
  tenantId: string,
  id: string,
  ownerUserId: string | null
): Promise<LeadRow | undefined> {
  const [row] = await db
    .update(exampleLeads)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(and(eq(exampleLeads.tenantId, tenantId), eq(exampleLeads.id, id)))
    .returning()
  return row
}

export async function scoreLead(
  db: Database,
  tenantId: string,
  id: string,
  score: number,
  status: LeadStatus
): Promise<void> {
  await db
    .update(exampleLeads)
    .set({ score, status, updatedAt: new Date() })
    .where(and(eq(exampleLeads.tenantId, tenantId), eq(exampleLeads.id, id)))
}

/** Hands `userId`'s open (not disqualified) leads back to the pool; returns how many. */
export async function releaseLeadsOf(
  db: Database,
  tenantId: string,
  userId: string
): Promise<number> {
  const rows = await db
    .update(exampleLeads)
    .set({ ownerUserId: null, updatedAt: new Date() })
    .where(
      and(
        eq(exampleLeads.tenantId, tenantId),
        eq(exampleLeads.ownerUserId, userId),
        ne(exampleLeads.status, 'disqualified')
      )
    )
    .returning({ id: exampleLeads.id })
  return rows.length
}
