/**
 * Test harness for the UI (06 §12). Wraps `QueryClientProvider` → `AuthProvider` → `AbilityProvider`
 * → `MemoryRouter`, mirroring App.tsx. The `session` option seeds the query cache AND stubs `fetch`
 * for `/auth/session` (composing with whatever the test already stubbed) so a test never builds
 * the auth stack by hand. Fixtures are post-parse shapes (real `Date`s), built by `makeSession`.
 */
import type { SessionResponse, TenantSummary, User } from '@rocketflare/shared/auth'
import type { MembershipRole } from '@rocketflare/shared/tenants'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RenderOptions, render } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { buildAbility, packRules } from '@/permissions'
import { AbilityProvider } from '@/ui/components/permissions/AbilityContext'
import { AuthProvider } from '@/ui/hooks/useAuth'
import { NavigationBridge } from '@/ui/lib/navigation'
import { queryKeys } from '@/ui/lib/query-keys'

interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial router location (default `/`) */
  route?: string
  /** Supply your own client to assert on the cache */
  queryClient?: QueryClient
  /**
   * `SessionResponse` → signed in (seeded + fetch-stubbed); `null` → `/auth/session` answers 401;
   * omitted → the auth stack is mounted but fetch is left exactly as the test stubbed it.
   */
  session?: SessionResponse | null
}

/** A fresh client with retries off so failing queries settle immediately. */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', queryClient = createTestQueryClient(), session, ...options }: ProviderOptions = {}
) {
  if (session !== undefined) {
    stubSessionFetch(session)
    if (session) queryClient.setQueryData(queryKeys.auth.session, session)
  }

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AbilityProvider>
            <MemoryRouter
              initialEntries={[route]}
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <NavigationBridge />
              {children}
            </MemoryRouter>
          </AbilityProvider>
        </AuthProvider>
      </QueryClientProvider>
    )
  }
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) }
}

// ------------------------------------------------------------------ fetch stubs

/** JSON `Response` helper for `vi.stubGlobal('fetch', …)`. */
export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function errorResponse(status: number, error = 'Error', code?: string) {
  return jsonResponse({ error, statusCode: status, code }, status)
}

export const notFoundResponse = () => errorResponse(404, 'Not found', 'not_found')
export const unauthorizedResponse = () => errorResponse(401, 'Unauthorized', 'unauthorized')

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** `{ 'GET /api/members': handler }`; the method defaults to GET when omitted from the key. */
export type RouteTable = Record<
  string,
  Response | unknown | ((init: RequestInit | undefined, url: URL) => Response | unknown)
>

function urlOf(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return new URL(raw, 'http://localhost')
}

function toResponse(value: unknown): Response {
  if (value instanceof Response) return value
  if (value === undefined) return new Response(null, { status: 204 })
  return jsonResponse(value)
}

/**
 * Stub `fetch` from a route table. Keys are `"METHOD /path"` (path compared without the query
 * string); unmatched requests 404 with the shared envelope. Returns the mock for call assertions.
 */
export function stubFetch(routes: RouteTable = {}) {
  const fn = vi.fn<FetchLike>(async (input, init) => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    for (const [key, value] of Object.entries(routes)) {
      const [m, p] = key.includes(' ') ? key.split(' ', 2) : ['GET', key]
      if (m.toUpperCase() !== method || p !== url.pathname) continue
      return toResponse(typeof value === 'function' ? value(init, url) : value)
    }
    return notFoundResponse()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Layer a `/auth/session` answer over whatever `fetch` the test already installed. */
export function stubSessionFetch(session: SessionResponse | null) {
  const previous: FetchLike | undefined =
    typeof globalThis.fetch === 'function' ? (globalThis.fetch as FetchLike) : undefined
  const fn = vi.fn<FetchLike>(async (input, init) => {
    const url = urlOf(input)
    if (url.pathname === '/auth/session' && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return session ? jsonResponse(session) : unauthorizedResponse()
    }
    if (previous) return previous(input, init)
    return notFoundResponse()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Stub `fetch` so `/api/health` answers with the given app info; everything else 404s. */
export function stubHealthFetch(info: Record<string, unknown> = {}) {
  return stubFetch({
    '/api/health': { status: 'ok', version: '1.2.3', env: 'staging', ...info },
  })
}

/** Body of the JSON request made to `"METHOD /path"`, or undefined if never called. */
export function requestBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>, key: string) {
  const [m, p] = key.split(' ', 2)
  const call = fetchMock.mock.calls.find(([input, init]) => {
    return (init?.method ?? 'GET').toUpperCase() === m && urlOf(input).pathname === p
  })
  if (!call?.[1]?.body) return undefined
  return JSON.parse(String(call[1].body)) as unknown
}

// --------------------------------------------------------------------- fixtures

export const IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  otherUser: '22222222-2222-4222-8222-222222222222',
  tenant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherTenant: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: IDS.user,
    email: 'owner@example.test',
    name: 'Olive Owner',
    avatarUrl: null,
    isGlobalAdmin: false,
    emailVerifiedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  }
}

export function makeTenant(overrides: Partial<TenantSummary> = {}): TenantSummary {
  return { id: IDS.tenant, name: 'Acme', slug: 'acme', role: 'owner', ...overrides }
}

/** Packed rules EXACTLY as the server emits them for this role (same matrix, same packer). */
export function rulesFor(
  role: MembershipRole | null,
  isGlobalAdmin = false,
  features: string[] = []
) {
  return packRules(buildAbility({ role, isGlobalAdmin, features }))
}

/**
 * A signed-in owner of Acme by default. Pass `tenant: null` for the "no active tenant" states;
 * `permissions` follows `tenant.role`/`user.isGlobalAdmin` unless given explicitly.
 */
export function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
  const user = overrides.user ?? makeUser()
  const tenant = overrides.tenant === undefined ? makeTenant() : overrides.tenant
  const tenants = overrides.tenants ?? (tenant ? [tenant] : [])
  return {
    user,
    tenant,
    tenants,
    permissions: rulesFor(tenant?.role ?? null, user.isGlobalAdmin),
    features: [],
    accessRequest: null,
    tenancyMode: 'multi',
    signupMode: 'invite_only',
    version: '1.2.3',
    ...overrides,
  }
}

/** `{ items, pagination }` for a one-page list response. */
export function paged<T>(items: T[], pageSize = 25) {
  return {
    items,
    pagination: { page: 1, pageSize, total: items.length, totalPages: 1 },
  }
}
