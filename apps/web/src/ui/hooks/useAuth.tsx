/**
 * Session state for the whole UI (D9, D20, D25). ONE query — `GET /auth/session`, zod-parsed with
 * the same `sessionResponseSchema` the server validates with — and everything the shell needs
 * derived from it: who, which org, which modes the server runs. A 401 resolves the query to `null`
 * ("logged out") rather than erroring, so the session query is never removed from the cache and
 * every observer sees identity changes synchronously via `setQueryData`.
 *
 * `AuthProvider` also owns the global 401 handler (D20): a stale session drops the cache and sends
 * the reader to `/login?returnUrl=`. Provider order (06 §b): QueryClientProvider → AuthProvider →
 * AbilityProvider → BrowserRouter, so this file never calls `useNavigate`; it goes through
 * `lib/navigation.ts`.
 */
import {
  type SessionResponse,
  type SignupMode,
  sessionResponseSchema,
  type TenancyMode,
  type TenantSummary,
  type User,
} from '@rocketflare/shared/auth'
import { type QueryClient, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react'
import { ApiError, api, setUnauthorizedHandler } from '@/ui/lib/api-client'
import { currentPath, currentPathname, loginUrl, navigateTo } from '@/ui/lib/navigation'
import { queryKeys } from '@/ui/lib/query-keys'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

export interface AuthContextValue {
  status: AuthStatus
  /** The parsed session, or null while loading / when logged out */
  session: SessionResponse | null
  user: User | null
  /** The active tenant — null when the user belongs to none (see `noTenantRoute`) */
  tenant: TenantSummary | null
  tenants: TenantSummary[]
  isGlobalAdmin: boolean
  tenancyMode: TenancyMode
  signupMode: SignupMode
  /** A non-401 failure of the session request (network, 5xx) — `ProtectedRoute` offers a retry */
  error: Error | null
  /** `POST /auth/select-tenant`; the returned session replaces the cache */
  selectTenant: (tenantId: string) => Promise<SessionResponse>
  /** `POST /auth/logout`; drops the cache and lands on /login (optionally with a returnUrl) */
  logout: (returnUrl?: string) => Promise<void>
  /** Refetch the session (after accepting an invite, changing profile…) */
  refresh: () => Promise<void>
  /** Replace the cached session with one a mutation returned (invite accept, select-tenant) */
  applySession: (session: SessionResponse) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Where a signed-in user with NO active tenant belongs (D9). A pending/rejected access request
 * always wins; otherwise pick an org, or wait for approval, or learn that invites are required.
 */
export function noTenantRoute(
  session: Pick<SessionResponse, 'accessRequest' | 'tenants' | 'signupMode'>
) {
  if (session.accessRequest) return '/pending'
  if (session.tenants.length > 0) return '/select-tenant'
  return session.signupMode === 'approval' ? '/pending' : '/no-access'
}

/** Routes a logged-out reader may sit on — the 401 handler never redirects from these. */
export const PUBLIC_PATHS = ['/login', '/magic-link', '/invite']
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/** 5 minutes: seeded sessions (tests, select-tenant) must not refetch on mount. */
export const SESSION_STALE_TIME = 5 * 60 * 1000

/** `null` = not signed in. Any other failure propagates (network, 5xx) for the retry panel. */
async function fetchSession(): Promise<SessionResponse | null> {
  try {
    return await api.get('/auth/session', { schema: sessionResponseSchema })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.auth.session,
    queryFn: fetchSession,
    staleTime: SESSION_STALE_TIME,
    retry: false,
  })
}

/** Everything except the session itself and the immutable app info. */
const isTenantScoped = (key: readonly unknown[]) => key[0] !== 'auth' && key[0] !== 'app-info'

/**
 * Identity changed: write the new session (or `null`) into the existing query so observers update
 * synchronously, then drop every tenant-scoped query. Mounted ones refetch against the new cookie.
 */
export function replaceSession(queryClient: QueryClient, session: SessionResponse | null) {
  queryClient.setQueryData(queryKeys.auth.session, session)
  if (session) {
    void queryClient.resetQueries({ predicate: q => isTenantScoped(q.queryKey) })
  } else {
    queryClient.removeQueries({ predicate: q => isTenantScoped(q.queryKey) })
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const sessionQuery = useQuery(sessionQueryOptions())

  const applySession = useCallback(
    (session: SessionResponse) => replaceSession(queryClient, session),
    [queryClient]
  )

  // Global 401 (D20). Only acts when we BELIEVED we were signed in — a 401 while logged out is the
  // normal state of the login page and must not clear-and-redirect (that would loop).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!queryClient.getQueryData(queryKeys.auth.session)) return
      const target = loginUrl(currentPath())
      replaceSession(queryClient, null)
      if (!isPublicPath(currentPathname())) navigateTo(target, { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [queryClient])

  const selectTenant = useCallback(
    async (tenantId: string) => {
      const session = await api.post(
        '/auth/select-tenant',
        { tenantId },
        { schema: sessionResponseSchema }
      )
      applySession(session)
      return session
    },
    [applySession]
  )

  const logout = useCallback(
    async (returnUrl?: string) => {
      try {
        await api.post('/auth/logout', undefined, { showErrorToast: false })
      } finally {
        replaceSession(queryClient, null)
        navigateTo(returnUrl ? loginUrl(returnUrl) : '/login', { replace: true })
      }
    },
    [queryClient]
  )

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session })
  }, [queryClient])

  const { data, error: queryError, isPending } = sessionQuery
  const value = useMemo<AuthContextValue>(() => {
    const session = data ?? null
    return {
      status: isPending ? 'loading' : session ? 'authenticated' : 'unauthenticated',
      session,
      user: session?.user ?? null,
      tenant: session?.tenant ?? null,
      tenants: session?.tenants ?? [],
      isGlobalAdmin: session?.user.isGlobalAdmin ?? false,
      tenancyMode: session?.tenancyMode ?? 'multi',
      signupMode: session?.signupMode ?? 'invite_only',
      error: queryError ?? null,
      selectTenant,
      logout,
      refresh,
      applySession,
    }
  }, [data, queryError, isPending, selectTenant, logout, refresh, applySession])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}

/** `'single'` hides OrgSwitcher, /select-tenant and org create/delete (D25). */
export function useTenancyMode(): TenancyMode {
  return useAuth().tenancyMode
}
