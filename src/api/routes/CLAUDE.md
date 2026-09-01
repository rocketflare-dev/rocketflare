# API Routes

Hono routers mounted in `src/api/index.ts`. Thin controllers: validate → authorise → query → respond.

## Layout (Phase 0)

- `health.ts` — `/api/health` (liveness: version + env), `/api/ready` (SELECT 1 via `c.get('db')`, 503 envelope). Public.
- Phase 1 adds `auth/`, `members.ts`, `invitations.ts`, `tenants.ts`, `admin.ts`, `keys.ts`, `notifications.ts`, `user-settings.ts`, `tenant-settings.ts` (00-SYNTHESIS §2).

## Rules

- `createRouter()` from `utils/routes/router.ts` — never `new Hono()` (D13). It gives `c.get('config' | 'db' | 'logger' | 'requestId')` types.
- Request contracts are zod schemas in `src/shared/` (UI imports them too). Validate with `validate('json' | 'query' | 'param', schema)` from `utils/routes/validate.ts`; a bad input becomes the shared 400 envelope with `code: 'validation_failed'`.
- Read config via `c.get('config')`, never `c.env` (D3). Bindings (KV, R2, queues) are the middleware's business.
- Throw typed errors from `utils/core/errors.ts` (`NotFoundError`, `ForbiddenError`, ...). Do not hand-roll `c.json({ error }, 4xx)`; `middleware/error-handler.ts` owns the envelope `{ error, statusCode, code?, details? }`.
- Success bodies are bare domain objects (no envelope). Lists use `paginatedResponse(item)` from `src/shared/pagination.ts` → `{ items, pagination: { page, pageSize, total, totalPages } }`.
- Auth is applied AT THE MOUNT in `index.ts` (`app.use('/api/x/*', authMiddleware); app.route('/api/x', xRouter)`), never inside a route file. Every tenant-scoped query carries `eq(table.tenantId, tenantId)` from the auth context — never from the body/query.
- Side effects that may outlive the response (emails, broadcasts, usage writes) go through `c.executionCtx.waitUntil(...)`; a detached promise is killed when the response ends.
- Routes enqueue, never run: anything longer than a request is a queue message or a Workflow (D7).

## Route anatomy (Phase 1 shape)

```ts
router.post('/', validate('json', createThingSchema), async c =>
  withAuthAndDb(c, async ({ db, tenantId, ability }) => {
    guard(ability, 'create', 'Thing')
    const [row] = await db.insert(things).values({ ...c.req.valid('json'), tenantId }).returning()
    return row
  })
)
```

New endpoint checklist: schema in `src/shared/` → `validate(...)` → auth seam + permission guard →
tenant-scoped query → tests in `tests/api/` → update this file if a new router appears.
