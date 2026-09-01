/**
 * Query-key factory (D13, D20). Every `useQuery`/`invalidateQueries` uses a key from here — never
 * an inline array — so one invalidation reliably covers a family (`all` is the prefix of everything
 * beneath it). Filters are spread into the key as a plain object (TanStack hashes them stably).
 *
 * Families are deliberately independent (`members` is NOT under `tenant`) so a tenant rename does
 * not refetch the member list; switching tenant clears the whole client instead (useAuth).
 */
/** Cleaned filters as they appear in a key. Callers pass any plain object (interfaces welcome). */
export type Filters = Record<string, string | number | boolean>

export const queryKeys = {
  /** `/api/health` — version + environment; effectively immutable for the tab's lifetime */
  appInfo: {
    all: ['app-info'] as const,
  },
  /** `/auth/*` — the session is the UI's bootstrap; methods drive the login page */
  auth: {
    all: ['auth'] as const,
    session: ['auth', 'session'] as const,
    methods: ['auth', 'methods'] as const,
    providers: ['auth', 'providers'] as const,
  },
  /** `/api/me*` — the signed-in person and their per-tenant preferences */
  me: {
    all: ['me'] as const,
    profile: ['me', 'profile'] as const,
    preferences: ['me', 'preferences'] as const,
  },
  /** `/api/tenant*` — the active organisation and its settings */
  tenant: {
    all: ['tenant'] as const,
    current: ['tenant', 'current'] as const,
    settings: ['tenant', 'settings'] as const,
  },
  /** `/api/tenants` — every organisation the user belongs to */
  tenants: {
    all: ['tenants'] as const,
  },
  members: {
    all: ['members'] as const,
    list: (filters: object = {}) => ['members', 'list', filters] as const,
  },
  invitations: {
    all: ['invitations'] as const,
    list: (filters: object = {}) => ['invitations', 'list', filters] as const,
    /** Public `/api/invite/:token` details — keyed by token, never by tenant */
    details: (token: string) => ['invitations', 'details', token] as const,
  },
  /** `/api/invitations/pending` — MY invitations across tenants (banner) */
  pendingInvitations: {
    all: ['pending-invitations'] as const,
  },
  keys: {
    all: ['keys'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (filters: object = {}) => ['notifications', 'list', filters] as const,
    unreadCount: ['notifications', 'unread-count'] as const,
  },
  activity: {
    all: ['activity'] as const,
    list: (filters: object = {}) => ['activity', 'list', filters] as const,
  },
  /** `/api/ai/*` — providers, readiness, prompt registry and usage (D17, D18) */
  ai: {
    all: ['ai'] as const,
    configs: ['ai', 'configs'] as const,
    providers: ['ai', 'providers'] as const,
    readiness: ['ai', 'readiness'] as const,
    prompts: ['ai', 'prompts'] as const,
    usage: {
      all: ['ai', 'usage'] as const,
      summary: (filters: object = {}) => ['ai', 'usage', 'summary', filters] as const,
    },
    /** `/api/ai/agent-models` — every prompt key with its assignment + effective model (D17) */
    agentModels: ['ai', 'agent-models'] as const,
  },
  /** `/api/agents` — the registered agent roster (code: changes with a deploy) (D7) */
  agents: {
    all: ['agents'] as const,
    list: ['agents', 'list'] as const,
  },
  /**
   * `/api/agents/runs` (D7, D8). The root is `agent-run` ON PURPOSE: the server's progress nudge is
   * `entity.changed { entity: 'agent-run', id }` and `invalidationsFor()` resolves that payload's
   * `entity` to a query-key root, so `WebSocketProvider` refreshes the runs list and the open run
   * with zero hook-side socket code. Its own family (not under `agents`) so a run event never
   * refetches the registry.
   */
  agentRuns: {
    all: ['agent-run'] as const,
    list: (filters: object = {}) => ['agent-run', 'list', filters] as const,
    detail: (id: string) => ['agent-run', 'detail', id] as const,
  },
  /** `/api/ai/documents` — the tenant knowledge base and its search (D18) */
  documents: {
    all: ['documents'] as const,
    list: (filters: object = {}) => ['documents', 'list', filters] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
  },
  /** `/api/chat/*` — MY conversations (the route filters by user) and their messages (D17) */
  chat: {
    all: ['chat'] as const,
    conversations: {
      all: ['chat', 'conversations'] as const,
      list: (filters: object = {}) => ['chat', 'conversations', 'list', filters] as const,
      detail: (id: string) => ['chat', 'conversations', 'detail', id] as const,
    },
  },
  /**
   * `/api/analytics/*` + `/cubejs-api/v1/meta` (D19). Pages are one family so a create/reset/
   * recreate invalidates the list and every open detail together; templates and the fact-table
   * status are effectively immutable for a tab; cube meta changes only with a deploy.
   */
  analytics: {
    all: ['analytics'] as const,
    pages: {
      all: ['analytics', 'pages'] as const,
      list: ['analytics', 'pages', 'list'] as const,
      detail: (id: string) => ['analytics', 'pages', 'detail', id] as const,
    },
    templates: ['analytics', 'templates'] as const,
    factsStatus: ['analytics', 'facts-status'] as const,
    cubeMeta: ['analytics', 'cube-meta'] as const,
  },
  /** `/api/admin/*` — cross-tenant; one `admin.all` invalidation after any admin mutation */
  admin: {
    all: ['admin'] as const,
    accessRequests: {
      all: ['admin', 'access-requests'] as const,
      list: (filters: object = {}) => ['admin', 'access-requests', 'list', filters] as const,
    },
    tenants: {
      all: ['admin', 'tenants'] as const,
      list: (filters: object = {}) => ['admin', 'tenants', 'list', filters] as const,
      detail: (id: string) => ['admin', 'tenants', 'detail', id] as const,
    },
    users: {
      all: ['admin', 'users'] as const,
      list: (filters: object = {}) => ['admin', 'users', 'list', filters] as const,
      detail: (id: string) => ['admin', 'users', 'detail', id] as const,
    },
  },
} as const

/** Drop undefined/empty filters so `{ q: '' }` and `{}` share one cache entry. */
export function cleanFilters(filters: object): Filters {
  const out: Filters = {}
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v
  }
  return out
}

/** `?page=2&q=acme` from the same cleaned filters the key uses. */
export function toSearchParams(filters: object): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(cleanFilters(filters))) params.set(k, String(v))
  const s = params.toString()
  return s ? `?${s}` : ''
}
