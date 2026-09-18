/**
 * Queries behind `/api/example-feature/notes` (D31). A plugin's service obeys the kit's service
 * rule exactly: a plain module taking `(db, …)`, importing no binding and reading no config global
 * — so the route stays thin and every query is testable without a request.
 *
 * **The tenant predicate is on every statement**, taken from the caller's auth context and never
 * from anything a client sent. `tests/config/unscoped-allowlist.test.ts` scans `src/**`, which
 * includes this file, so a query that forgot one fails the host's suite like a kit one.
 */

import type { PaginationQuery } from '@rocketflare/shared/pagination'
import type { CreateExampleNoteRequest } from '@rocketflare/shared/plugins/example-feature/index'
import { and, desc, eq } from 'drizzle-orm'
// `Database` is one of the handful of types a plugin NAMES rather than receives: this module is the
// kit's service shape — a plain `(db, tenantId, …)` function one plugin calls from a route, a job,
// a hook and an agent tool alike — and such a function cannot take "whichever context this is".
import type { Database } from '@/plugins/api'
import { type ExampleNoteRow, exampleNotes } from '../db/schema'

export async function listExampleNotes(
  db: Database,
  tenantId: string,
  { page, pageSize }: PaginationQuery
): Promise<{ items: ExampleNoteRow[]; total: number }> {
  const where = eq(exampleNotes.tenantId, tenantId)
  const [items, total] = await Promise.all([
    db
      .select()
      .from(exampleNotes)
      .where(where)
      .orderBy(desc(exampleNotes.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.$count(exampleNotes, where),
  ])
  return { items, total }
}

/** One note, or undefined. Another tenant's id answers the same "not found" as an unknown one. */
export async function getExampleNote(
  db: Database,
  tenantId: string,
  id: string
): Promise<ExampleNoteRow | undefined> {
  const [row] = await db
    .select()
    .from(exampleNotes)
    .where(and(eq(exampleNotes.tenantId, tenantId), eq(exampleNotes.id, id)))
    .limit(1)
  return row
}

export async function createExampleNote(
  db: Database,
  tenantId: string,
  ownerUserId: string,
  input: CreateExampleNoteRequest
): Promise<ExampleNoteRow> {
  const [row] = await db
    .insert(exampleNotes)
    .values({ tenantId, ownerUserId, title: input.title, body: input.body })
    .returning()
  if (!row) throw new Error('example-feature: insert returned no row')
  return row
}

export async function updateExampleNote(
  db: Database,
  tenantId: string,
  id: string,
  patch: Partial<CreateExampleNoteRequest>
): Promise<ExampleNoteRow | undefined> {
  const [row] = await db
    .update(exampleNotes)
    .set(patch)
    .where(and(eq(exampleNotes.tenantId, tenantId), eq(exampleNotes.id, id)))
    .returning()
  return row
}

export async function deleteExampleNote(
  db: Database,
  tenantId: string,
  id: string
): Promise<boolean> {
  const rows = await db
    .delete(exampleNotes)
    .where(and(eq(exampleNotes.tenantId, tenantId), eq(exampleNotes.id, id)))
    .returning({ id: exampleNotes.id })
  return rows.length > 0
}
