# API Routes

Hono routers mounted in `src/api/index.ts`. Thin controllers: validate → authorise → query → respond.

## Layout

- `health.ts` — `/api/health`, `/api/ready`. Public.
- `auth/` — public (rate-limited where login-shaped): `session.ts` (`/auth/methods|session|select-tenant|logout`), `magic-link.ts` (`/auth/magic-link/request|verify`), `oauth.ts` (ONE generic `/auth/:provider` + `/callback` over `auth/providers`), `dev-login.ts` (development only), `providers.ts` (linked identities), `cli.ts` (`/auth/cli?redirect_uri=` loopback key hand-off, D26), `helpers.ts` (`completeLogin`, `safeRedirectPath`). Static routes mount BEFORE the generic `/:provider` router.
- `invite.ts` — public `GET /api/invite/:token`, cookie-required `POST /api/invite/:token/accept` (transactional).
- Behind `authMiddleware` (cookie or Bearer): `me.ts`, `tenant.ts` (current tenant + `/settings`), `tenants.ts` (mine; create — multi only), `members.ts`, `invitations.ts` (+ tenant-free `GET /pending`), `keys.ts`, `notifications.ts`, `activity.ts`, `access-requests.ts` (tenant-free).
- Behind `globalAdminMiddleware`: `admin.ts` — the only cross-tenant surface; logic in `services/admin.ts`.
- Logic lives in `services/{auth,tenants,members,invitations,admin,notifications,activity,email}.ts`; routes validate → authorise → call a service → respond.

## Rules

- `createRouter()` from `utils/routes/router.ts` — never `new Hono()` (D13). It gives `c.get('config' | 'db' | 'logger' | 'requestId')` types.
- Request contracts are zod schemas in `src/shared/` (UI imports them too). Validate with `validate('json' | 'query' | 'param', schema)` from `utils/routes/validate.ts`; a bad input becomes the shared 400 envelope with `code: 'validation_failed'`.
- Read config via `c.get('config')`, never `c.env` (D3). Bindings (KV, R2, queues) are the middleware's business.
- Throw typed errors from `utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, ...). Do not hand-roll `c.json({ error }, 4xx)`; `middleware/error-handler.ts` owns the envelope `{ error, statusCode, code?, details? }`.
- Success bodies are bare domain objects (no envelope). Lists use `paginatedResponse(item)` from `src/shared/pagination.ts` → `{ items, pagination: { page, pageSize, total, totalPages } }`.
- Auth is applied AT THE MOUNT in `index.ts` (`app.use('/api/x/*', authMiddleware); app.route('/api/x', xRouter)`), never inside a route file. Every tenant-scoped query carries `eq(table.tenantId, tenantId)` from the auth context — never from the body/query.
- Side effects that may outlive the response (emails, broadcasts, usage writes) go through `c.executionCtx.waitUntil(...)`; a detached promise is killed when the response ends.
- Routes enqueue, never run: anything longer than a request is a queue message or a Workflow (D7).

## Route anatomy

```ts
router.post('/', validate('json', createThingSchema), async c => {
  const { db, tenantId, user, defer } = withAuthAndDb(c) // throws 401 / 403 no_tenant|pending_approval
  guardPermission(c, 'create', 'Thing')
  const [row] = await db.insert(things).values({ ...c.req.valid('json'), tenantId }).returning()
  defer(() => recordActivity(db, { tenantId, userId: user.id, type: 'thing.created', subjectType: 'Thing', subjectId: row.id }))
  return c.json(row, 201)
})
```

`withAuth(c)` is the tenant-free variant (`tenantId: string | null`) for invite accept, pending
invitations, access requests and `/api/admin/*`. `requireMultiTenant(cfg)` → 404 `tenancy_mode_single`.

New endpoint checklist: schema in `src/shared/` → `validate(...)` → auth seam + permission guard →
tenant-scoped query → tests in `tests/api/` → update this file if a new router appears.
