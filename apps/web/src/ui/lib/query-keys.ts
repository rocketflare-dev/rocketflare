/**
 * Query-key factory. Every `useQuery`/`invalidateQueries` uses a key from here — never an
 * inline array — so one invalidation reliably covers a family (`all` is the prefix of
 * everything beneath it). Filters are `JSON.stringify`ed into the key.
 *
 * Phase 1 adds: `auth` (session, methods), `profile`, `members`, `invitations`, `keys`,
 * `tenantSettings`, `notifications`, `admin` (accessRequests, tenants, users).
 */
export const queryKeys = {
  /** `/api/health` — version + environment; effectively immutable for the tab's lifetime */
  appInfo: {
    all: ['app-info'] as const,
  },
} as const
