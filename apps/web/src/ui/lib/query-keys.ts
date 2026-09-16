/**
 * Query-key factory (D13, D20). Every `useQuery`/`invalidateQueries` uses a key from here — never
 * an inline array — so one invalidation reliably covers a family (`all` is the prefix of everything
 * beneath it). Filters are spread into the key as a plain object (TanStack hashes them stably).
 *
 * Families are deliberately independent (`members` is NOT under `tenant`) so a tenant rename does
 * not refetch the member list; switching tenant clears the whole client instead (useAuth).
 */
import { type UI_PLUGINS, uiPlugins } from '@/plugins/ui'

/** Cleaned filters as they appear in a key. Callers pass any plain object (interfaces welcome). */
export type Filters = Record<string, string | number | boolean>

/** `A | B | C` → `A & B & C`. Distributes over the union, then collapses it by inference. */
type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I
) => void
  ? I
  : never

const CORE_QUERY_KEYS = {
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
    /** `GET /runs/:id?events=0` — the bare row, one indexed read, refreshed by the nudge. */
    row: (id: string) => ['agent-run', 'row', id] as const,
    /**
     * `GET /interrupts?status=pending&pageSize=1` — the "n waiting" SideNav badge (issue #17).
     * Under `['agent-run']` so BOTH server nudges already cover it: a park writes an `interrupt`
     * event row (`entity: 'agent-run'`) and an answer additionally nudges `agent-interrupt`.
     * **Never polled** — a badge that polls is a request every few seconds on every page.
     */
    awaiting: ['agent-run', 'awaiting'] as const,
  },
  /**
   * The run's AG-UI timeline (issue #7) — **its own root on purpose, and it must stay out of
   * `REALTIME_INVALIDATIONS`.** The kit's convention is that an `entity.changed` entity string IS
   * a query-key root, and the runtime nudges `entity: 'agent-run'` on EVERY durable row it writes.
   * Park this list under `['agent-run']` and each of those nudges throws away the list the stream
   * just built and re-fetches the whole run — turning the stream into a more expensive poll.
   */
  agentRunAgui: {
    all: ['agent-run-agui'] as const,
    detail: (id: string) => ['agent-run-agui', id] as const,
  },
  /** `/api/ai/documents` — the tenant knowledge base and its search (D18) */
  documents: {
    all: ['documents'] as const,
    list: (filters: object = {}) => ['documents', 'list', filters] as const,
    detail: (id: string) => ['documents', 'detail', id] as const,
    /** One window of the text — keyed by offset so paging keeps each window cached (D18). */
    content: (id: string, offset: number) => ['documents', 'content', id, offset] as const,
    passages: (id: string, filters: object = {}) => ['documents', 'passages', id, filters] as const,
    card: (id: string) => ['documents', 'card', id] as const,
  },
  /** `/api/chat/*` — MY conversations (the route filters by user) and their messages (D17) */
  chat: {
    all: ['chat'] as const,
    conversations: {
      all: ['chat', 'conversations'] as const,
      list: (filters: object = {}) => ['chat', 'conversations', 'list', filters] as const,
      detail: (id: string) => ['chat', 'conversations', 'detail', id] as const,
      /** The inspector's derived view of one thread (admin+); same family, so a turn refreshes it. */
      stats: (id: string) => ['chat', 'conversations', 'stats', id] as const,
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
  /**
   * `/api/groups` (D29). The root is `groups` because the server nudges
   * `entity.changed { entity: 'groups' }` from every group mutation, and `access.changed` names it
   * too — so the admin UI and a person's own group list both refresh with no socket code here.
   */
  groups: {
    all: ['groups'] as const,
    types: ['groups', 'types'] as const,
    list: (filters: object = {}) => ['groups', 'list', filters] as const,
    detail: (id: string) => ['groups', 'detail', id] as const,
    mine: ['groups', 'mine'] as const,
  },
  /**
   * `/api/features` (D30). The root is `features` because the server's `features.changed` nudge
   * names it alongside `auth` — flags ride the session, so both have to be re-fetched when one moves.
   */
  features: {
    all: ['features'] as const,
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
    featureFlags: {
      all: ['admin', 'feature-flags'] as const,
      overrides: (key: string) => ['admin', 'feature-flags', 'overrides', key] as const,
    },
    users: {
      all: ['admin', 'users'] as const,
      list: (filters: object = {}) => ['admin', 'users', 'list', filters] as const,
      detail: (id: string) => ['admin', 'users', 'detail', id] as const,
    },
  },
} as const

/**
 * Families contributed by installed plugins (D31), merged in. Every root a plugin declares starts
 * with `<id>:` — `tests/config/plugins.test.ts` is the check — so a plugin can no more collide with
 * a kit family, or with another plugin's, than two plugins can share a table name.
 *
 * The cast is the price of merging objects the kit cannot know the shape of: at runtime this is
 * one spread, and at compile time it is the intersection of everything the barrel declares, which
 * is exactly what a plugin's own hooks need to see when they read `queryKeys`.
 */
type DeclaredQueryKeys = UnionToIntersection<NonNullable<(typeof UI_PLUGINS)[number]['queryKeys']>>
/** No plugins (or none with families) → `unknown`, which intersects away instead of erasing. */
type PluginQueryKeys = [DeclaredQueryKeys] extends [never] ? unknown : DeclaredQueryKeys

export const queryKeys = {
  ...CORE_QUERY_KEYS,
  ...(Object.assign({}, ...uiPlugins.map(p => p.queryKeys ?? {})) as Record<string, unknown>),
} as typeof CORE_QUERY_KEYS & PluginQueryKeys

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
