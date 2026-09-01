import { z } from 'zod'

/** Page-based pagination (page-based). Query: `?page=1&pageSize=25`. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export const paginationMetaSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
})

export type PaginationMeta = z.infer<typeof paginationMetaSchema>

/** `paginatedResponse(itemSchema)` → `{ items: Item[], pagination: PaginationMeta }` */
export function paginatedResponse<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), pagination: paginationMetaSchema })
}

export function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) }
}
