/**
 * Cube metadata (D19, D20): `GET /cubejs-api/v1/meta` — every cube with its measures and
 * dimensions, as drizzle-cube's Cube.js-compatible API describes them. Fetched through `api.get`
 * (cookie session, `X-Requested-With`, 401 → the global handler) and cached for the tab: the
 * schema only changes with a deploy. The zod shape here is permissive on purpose — the meta
 * document is drizzle-cube's contract, not ours — and keeps only what the kit UI reads
 * (`name`, `title`, `type`, `description`). Chart components inside `CubeProvider` use
 * drizzle-cube's own meta context; this hook is for kit UI outside it (pickers, labels).
 */
import { queryOptions, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

const cubeMemberSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    shortTitle: z.string().optional(),
    type: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .passthrough()
export type CubeMember = z.infer<typeof cubeMemberSchema>

const cubeInfoSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    measures: z.array(cubeMemberSchema).default([]),
    dimensions: z.array(cubeMemberSchema).default([]),
  })
  .passthrough()
export type CubeInfo = z.infer<typeof cubeInfoSchema>

export const cubeMetaSchema = z.object({ cubes: z.array(cubeInfoSchema) }).passthrough()
export type CubeMeta = z.infer<typeof cubeMetaSchema>

export const CUBE_META_STALE_MS = 60 * 60 * 1000

export function cubeMetaQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.analytics.cubeMeta,
    queryFn: () => api.get('/cubejs-api/v1/meta', { schema: cubeMetaSchema }),
    staleTime: CUBE_META_STALE_MS,
    gcTime: 24 * CUBE_META_STALE_MS,
  })
}

export function useCubeMeta(options: { enabled?: boolean } = {}) {
  return useQuery({ ...cubeMetaQueryOptions(), enabled: options.enabled ?? true })
}

/** `Cube.member` → its title (falls back to the member part of the name). Pure. */
export function memberTitle(meta: CubeMeta | undefined, member: string): string {
  const [cubeName] = member.split('.')
  const cube = meta?.cubes.find(c => c.name === cubeName)
  const found = [...(cube?.measures ?? []), ...(cube?.dimensions ?? [])].find(
    m => m.name === member
  )
  return found?.title ?? member.slice(member.indexOf('.') + 1)
}

/** The time dimensions of one cube — what a date filter can be mapped to. Pure. */
export function timeDimensionsOf(cube: CubeInfo): CubeMember[] {
  return cube.dimensions.filter(d => d.type === 'time')
}
