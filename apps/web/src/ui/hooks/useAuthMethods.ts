/** `GET /auth/methods` (D11): which sign-in methods the server has configured — drives Login. */
import { authMethodsSchema } from '@gmgo/shared/auth'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/ui/lib/api-client'
import { queryKeys } from '@/ui/lib/query-keys'

export function authMethodsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth.methods,
    queryFn: () => api.get('/auth/methods', { schema: authMethodsSchema }),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useAuthMethods() {
  return useQuery(authMethodsQueryOptions())
}
