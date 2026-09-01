/**
 * Page-based pagination glue (D13): `paginationQuerySchema` → `{ limit, offset }`, and
 * `paginated(items, total, query)` → `{ items, pagination }` per `src/shared/pagination.ts`.
 */
import { type PaginationQuery, paginationMeta } from '@gmgo/shared/pagination'

export function pageWindow(query: PaginationQuery): { limit: number; offset: number } {
  return { limit: query.pageSize, offset: (query.page - 1) * query.pageSize }
}

export function paginated<T>(items: T[], total: number, query: PaginationQuery) {
  return { items, pagination: paginationMeta(query.page, query.pageSize, total) }
}

/** `count(*)` arrives as a string or bigint from Postgres; normalise. */
export function asCount(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}
