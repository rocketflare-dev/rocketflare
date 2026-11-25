/**
 * Home's work areas: `GET /api/home/summary`, one request for every section. Each section reads
 * its own part of the same cached answer (`useHomeSummary()` everywhere, one fetch). A part the
 * reader may not see is `null`, and the section renders nothing.
 *
 * Fresh through realtime: the events behind each part invalidate `['home']`
 * (`REALTIME_INVALIDATIONS`, `HOME_ENTITY_ROOTS`). Like every nudged resource it still polls while
 * the server owes an answer — a run queued or running, a document still being indexed — in case
 * the socket is down, and never otherwise.
 */
import { type HomeSummary, homeSummarySchema } from '@rocketflare/shared/home'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

/** How often Home re-reads itself while something on it is still in progress. */
export const HOME_POLL_MS = 4000

/** How long a summary counts as fresh when another section mounts and asks for it. */
export const HOME_STALE_MS = 30_000

/** The pure polling decision: poll only while a run or a document on Home is still in progress. */
export function homePollInterval(summary: HomeSummary | undefined): number | false {
  const running = summary?.agents?.recent.some(r => r.status === 'queued' || r.status === 'running')
  const indexing = summary?.knowledge?.recent.some(d => d.status === 'pending')
  return running || indexing ? HOME_POLL_MS : false
}

export function homeSummaryQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.home.summary,
    queryFn: () => api.get('/api/home/summary', { schema: homeSummarySchema }),
    // Sections mount at different moments (the feature ones are lazy); without this each mount
    // would re-read a summary seconds old. Freshness comes from the nudges and the poll.
    staleTime: HOME_STALE_MS,
  })
}

export function useHomeSummary() {
  return useQuery({
    ...homeSummaryQueryOptions(),
    refetchInterval: q => homePollInterval(q.state.data),
  })
}
