# The plugin API

**Generated. Do not edit.** `node scripts/plugin-api-doc.mjs` writes this file from the source of
the declared entries, and `.github/workflows/gate.yml` regenerates it and diffs it — beside the
step that does the same for `apps/web/worker-configuration.d.ts`, and for the same reason: a
generated artefact that is committed and diff-checked cannot drift from its source. **A diff
failure means this file is stale. Run the script and commit what it writes.**

Two other failures come out of the same script and mean something different:

- *"changed without a bump"* — a member's signature moved, or the member is gone, while
  `PLUGIN_API.current` still reads 1. Either restore the member, or raise
  `current` in `packages/shared/src/plugins/contract.ts` and mirror it in
  `.rocketflare.json`. The script names the member.
- *"capability names a member that does not exist"* — the index at the top points at a symbol that
  has been renamed. Fix the index in the generator; a capability index nobody maintains is worse
  than none, because it sends the next reader to a name that is not there.

This is the whole of what a plugin may import from the host. The rule the entries make true is one
sentence: **a plugin imports only from declared entries, and receives everything else as injected
context** (`apps/web/tests/helpers/plugins.ts` enforces it, and every diagnostic it prints carries
the replacement import). Anything not listed here is a kit internal: reaching for it is what makes a
plugin's own version number meaningless, because the plugin is then pinned to something nobody
promised to keep.

## What you want to do

Read this first. It is the index the rest of the file is the reference for — one line per thing a
plugin actually does, and the single name that does it. Every entry below is checked to exist, so a
name here is a name you can import today.

| To… | Use | From |
|---|---|---|
| Handle a request | `requestCtx` | `@/plugins/api` |
| Build a router, validate a body | `createRouter` | `@/plugins/api` |
| Check what a role may do | `RequestCtx.guard` | `@/plugins/api` |
| Check what a row-level reader may see | `RequestCtx.scope` | `@/plugins/api` |
| Check whether this deployment ships a surface | `hasFeature` | `@/plugins/api` |
| Gate a whole mount on a feature flag | `requireFeature` | `@/plugins/api` |
| Read a `:id` parameter safely | `RequestCtx.uuid` | `@/plugins/api` |
| Answer a paginated list | `RequestCtx.page` | `@/plugins/api` |
| Fail with the shared error envelope | `RequestCtx.notFound` | `@/plugins/api` |
| Run a side effect after the response | `RequestCtx.defer` | `@/plugins/api` |
| Enqueue a job | `RequestCtx.enqueue` | `@/plugins/api` |
| Handle a job | `jobCtx` | `@/plugins/api` |
| Run a scheduled task | `cronCtx` | `@/plugins/api` |
| Run a durable multi-step workflow | `workflowCtx` | `@/plugins/api` |
| Park a run until somebody answers | `WorkflowCtx.waitForEvent` | `@/plugins/api` |
| Tell open tabs a family of rows moved | `RequestCtx.nudge` | `@/plugins/api` |
| Notify one person | `notify` | `@/plugins/api` |
| Write to the audit log | `recordActivity` | `@/plugins/api` |
| Reach a per-tenant Durable Object | `durableObject` | `@/plugins/api` |
| Store or read a file | `RequestCtx.storage` | `@/plugins/api` |
| Write several rows as one transaction | `transaction` | `@/plugins/api` |
| Seed a new organisation | `HookCtx` | `@/plugins/api` |
| Add rows to `pnpm seed --demo` | `SeedCtx` | `@/plugins/api` |
| Give every agent run a tool | `defineTool` | `@/plugins/api` |
| Read what the run’s requester may read | `ToolCtx` | `@/plugins/api` |
| Write an agent | `AgentCtx` | `@/plugins/api` |
| Make a side effect happen once per run | `AgentCtx.once` | `@/plugins/api` |
| Ledger a model call | `recordUsage` | `@/plugins/api` |
| Trace a model call | `withAgentTrace` | `@/plugins/api` |
| Restrict a row to groups | `sharedWithMyGroups` | `@/plugins/api` |
| Read or write who may see a row | `RequestCtx.visibility` | `@/plugins/api` |
| Read the reader’s groups and their types | `RequestCtx.groups` | `@/plugins/api` |
| Escape a handler with a snapshot | `RequestCtx.detached` | `@/plugins/api` |
| Read what other plugins contributed | `extensions` | `@/plugins/api/peers` |
| Hand a library the whole schema | `allTables` | `@/plugins/api/peers` |
| Declare a tenant-scoped table | `tenantRef` | `@/db/schema/kit` |
| Give a table its RLS policy | `tenantIsolation` | `@/db/schema/kit` |
| Add a nav item and a route | `UiPlugin` | `@/plugins/types` |
| Guard a nav item on a flag | `featureGuard` | `@/plugins/api/ui-wiring` |
| Call the API from a page | `api` | `@/plugins/api/ui` |
| Declare contracts, jobs, subjects, flags | `SharedPlugin` | `@rocketflare/shared/plugins/api` |
| Answer a paginated list, in the contract | `paginatedResponse` | `@rocketflare/shared/plugins/api` |
| Add a CLI command | `CliPlugin` | `'./types' (apps/cli/src/plugins/types.ts)` |
| Call the API from a command | `requireClient` | `'../api' (apps/cli/src/plugins/api.ts)` |
| Prove tenant isolation | `request` | `@testkit/integration` |
| Prove a cron task is dispatched | `dispatchScheduled` | `@testkit/integration` |
| Build a fake request context | `makeRequestCtx` | `@testkit/unit` |

## The plugin API version

```
current       1
minSupported  1
```

A plugin declares `requires.pluginApi` in its own `plugin.json` — **a whole number, never a
range**:

```json
"requires": { "kit": ">=0.6.0 <1.0.0", "pluginApi": "1" }
```

**It is not `requires.kit`, and merging the two is the bug this replaces.** `requires.kit` says
which kit RELEASES a plugin may be installed into; this says which version of the SURFACE above it
was written against. The kit cut three releases without the surface moving at all, and a plugin
pinned only by kit range had to be re-released for each — so every pin became a guess, and the
guesses drifted.

The comparison is integer and lives in one place, `scripts/lib/plugin-api.mjs`:

- declared > `current` — the plugin needs a newer kit.
- declared < `minSupported` — the plugin needs migrating to the current contract.
- **not declared at all — warned, never refused.** A plugin released before this existed cannot
  retroactively declare anything, and refusing it would break installs of plugins nobody can
  change. Declaring the version is what moves a plugin from *warned* to *checked*, and it happens
  in the release that migrates it.

There is deliberately no range language anywhere near this number. A malformed semver range throws
out of the matcher and reaches the caller as a generic failure with nothing to act on; an integer
has one way to be wrong and one sentence to say so.

## The entries

One section per declared entry. A nested list under a type is its own members: those are part
of the contract too, and removing one is a break the ledger catches.

### `@/plugins/api`

The server surface: the context family, and the types a plugin must be able to name.

> The plugin API — the ONE module a plugin's server half imports from the host (D31).

- `type AbilityCheck = (action: Actions, subject: Subjects) => boolean`
  The two-argument ability check, as a plugin's own helper takes it.
- `interface AccessScope`
- `type Actions = (typeof ACTIONS)[number]`
- `interface ActivityInput`
- `function agentCtx<Input>(ctx: AgentContext<Input>): AgentCtx<Input>`
  Adapt the runtime's `AgentContext`.
- `interface AgentCtx<Input = unknown>`
  What a plugin's `run(ctx)` is handed.
  - `db: Database`
  - `config: PluginConfig`
  - `env: PluginBindings`
  - `logger: AgentContext['logger']`
  - `tenantId: string`
  - `runId: string`
  - `userId: string \| null`
    Who asked; null for a system-triggered run.
  - `input: Input`
    Already validated against the agent's own `inputSchema`, twice: at enqueue and before `run()`.
  - `tools: Tool[]`
    The kit's knowledge tools plus every installed plugin's, bound to this run's scope.
  - `prompt(vars?: Record<string, string \| undefined>): Promise<string>`
    The system prompt for this agent's `promptKey`, with `appName`/`tenantName` filled in.
  - `step( key: string, label: string, status: 'running' \| 'done' \| 'error', detail?: string ): Promise<void>`
    A durable timeline row. Never throws — progress must not be able to fail a run.
  - `checkCancelled(): Promise<void>`
    Throws when the run was asked to stop. Call it between model turns; the loop takes no signal.
  - `once<T>(key: string, fn: () => Promise<T>): Promise<T>`
    Run `fn` at most once per `key` across every attempt, replaying its recorded result after.
  - `toolLoop(options: PluginToolLoopOptions): Promise<ToolLoopResult>`
    The agentic loop, with this run's client, model, ceiling and approval plumbing already bound.
  - `structured<T>(options: PluginStructuredOptions<T>): Promise<T>`
    One forced tool call, zod-validated, one retry with the issues fed back.
- `interface AgentTraceContext extends Omit<TraceParams, 'name'>`
- `class AiNotConfiguredError extends ServiceUnavailableError`
  503 `ai_not_configured`: nothing resolves for the tenant (no config row, no platform key).
- `type AnyServerPlugin = ServerPlugin<SharedPlugin>`
  The element type of the barrels — a plugin whose shared half is not narrowed.
- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `type AppRouter = Hono<AppEnv>`
- `function createRouter(): Hono<AppEnv>` — **used by** example-feature
- `function createStepRealtimeFor(env: HubEnv): StepRealtime`
- `function cronCtx(ctx: TaskContext): CronCtx`
  Adapt the kit's `TaskContext`.
- `interface CronCtx extends PluginContext, BackgroundMethods`
  One cron run. `waitUntil` exists here because a scheduled invocation genuinely has one.
  - `waitUntil(promise: Promise<unknown>): void`
- `type Database = PostgresJsDatabase<typeof schema>` — **used by** example-feature
- `interface DatabaseHandle`
- `function defineTool<Input>(tool: Tool<Input>): Tool<Input>` — **used by** example-feature
  Declare a tool. A thin helper, and its only job is to be the thing a plugin imports instead of the `Tool` type from a kit path — but it is also where the two rules in this file's…
- `interface DetachedCtx extends PluginContext`
  What survives the handler: data and a database, no request.
  - `tenantId: string`
  - `userId: string`
  - `role: PluginAuth['role']`
  - `isAdmin: boolean`
  - `features: readonly string[]`
  - `scope: AccessScope`
  - `groups: readonly GroupRef[]`
    As on `RequestCtx` — a value, so it survives the request that resolved it.
- `class DuplicateStepNameError extends Error`
  Thrown when a run reuses a step name — see rule 1.
- `function durableObject<T extends Rpc.DurableObjectBranded \| undefined = undefined>( namespace: DurableObjectNamespace<T>, tenantId: string, key?: string ): DurableObjectStub<T>`
  A Durable Object stub for one tenant, **with the tenant prefix built here rather than by the caller** (D31).
- `function hasFeature(auth: Pick<PluginAuth, 'features'>, name: string): boolean`
  `true` when this deployment ships the surface AND this organisation has it yet.
- `interface HookCtx extends Pick<PluginContext, 'db'>` — **used by** example-feature
  A lifecycle hook: `onTenantCreated`, `onTenantDeleted`, `seedDemo`.
  - `tenant: Tenant`
  - `tenantId: string`
  - `userId: string \| null`
    Who caused it — the signing-up user, the approving admin. Null for a system path.
  - `features: readonly string[]`
    The features this DEPLOYMENT ships (D30). A hook that CREATES rows is the sharpest feature door there is, because it has no nav entry to hide behind: seed nothing for a surface…
- `function isAdminLevel(session: RoleView): boolean`
  May administer members / invitations / keys: owner, admin, support, or global admin.
- `function isGlobalAdmin(session: RoleView): boolean`
  `users.isGlobalAdmin` — the platform flag, independent of any tenant role.
- `function isOwnerLevel(session: RoleView): boolean`
  Irreversible tenant actions: explicit `owner` (or global admin), NOT `manage Tenant`.
- `function jobCtx(ctx: JobContext): JobCtx` — **used by** example-feature
  Adapt the kit's `JobContext`. The only place a plugin's job half names a kit internal.
- `interface JobCtx extends PluginContext, BackgroundMethods` — **used by** example-feature
  One queue message. `job.payload` is already narrowed to the variant this handler was registered for — `ServerPlugin.jobHandlers` is checked against the job types the plugin's own…
- `type JobEnvelope = z.infer<typeof jobEnvelopeSchema>`
- `type JobHandler = ( job: Extract<JobEnvelope, { type: T }>, ctx: JobContext ) => Promise<void>` — **used by** example-feature
- `type JobInput = z.infer<typeof jobInputSchema>`
- `type JobOf = Extract<JobEnvelope, { type: T }>`
  The envelope narrowed to one `type` — what a handler receives.
- `type JobType = JobEnvelope['type']`
  Every job type this app knows, derived from the variants rather than kept beside them.
- `type Logger = pino.Logger`
- `type MembershipRole = z.infer<typeof membershipRoleSchema>`
- `const noopTracer: Tracer`
  What a request without Langfuse keys carries.
- `async function notify(db: Database, input: NotifyInput, realtime?: Realtime): Promise<void>`
- `interface NotifyInput`
- `async function notifyMany( db: Database, userIds: string[], input: Omit<NotifyInput, 'userId'>, realtime?: Realtime )`
  Same notification to several users (e.g. every owner/admin of a tenant).
- `function nudge(rt: Realtime \| undefined, event: RealtimeEvent): void`
  Tenant-wide nudge (member / invitation / tenant changes). No-op without a hub binding.
- `function nudgeEntity( realtime: Realtime \| undefined, tenantId: string, entity: string, id?: string ): void`
  Nudge every socket in one tenant that a family of rows moved.
- `function nudgeUser(rt: Realtime \| undefined, userId: string, event: RealtimeEvent): void`
  One user's sockets in the tenant (their notifications).
- `function nudgeUsers( rt: Realtime \| undefined, userIds: string[], event: RealtimeEvent ): void`
- `function pageWindow(query: PaginationQuery): { limit: number; offset: number }`
- `type PluginAgent = AgentDefinition<Input, Output>`
  A plugin's agent, as `ServerPlugin.agents` takes it.
- `interface PluginAuth`
  Who is asking, flattened — the half of the auth context a plugin has any business reading.
  - `user: User`
  - `userId: string`
  - `tenantId: string`
    The active organisation — the ONLY tenant id a query may filter by.
  - `role: MembershipRole \| null`
  - `isAdmin: boolean`
  - `isOwner: boolean`
  - `isGlobalAdmin: boolean`
  - `features: readonly string[]`
    Flags on for this organisation. Read with `hasFeature`, never through the ability.
- `type PluginBindings = AppBindings`
  What `ctx.env` is (`Cloudflare.Env`), named for the same reason.
- `type PluginConfig = AppConfig`
  What `ctx.config` is, named so a plugin's own function signature can take it.
- `interface PluginContext`
  The four things every execution context carries, whatever invoked it.
  - `db: Database`
    The drizzle handle for THIS unit of work, and never a value to store: a request's client is closed in `waitUntil` the moment the Response is returned, a job's in the consumer's…
  - `config: PluginConfig`
    Validated config, including whatever this plugin's `SharedPlugin.config` added to the schema.
  - `logger: PluginLogger`
  - `env: PluginBindings`
    The Worker bindings. A plugin reads the ones its own `plugin.json` declares; reaching for a kit binding directly is usually the sign that a method is missing from this surface.
- `type PluginLogger = Pick<Logger, 'debug' \| 'info' \| 'warn' \| 'error'>`
  The four level methods, and deliberately no more.
- `type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]`
  One entry of the mount table in `api/index.ts`: prefix, router, optional gate.
- `interface PluginNavGroup`
  A nav group, placed relative to a named core group ("Organisation" by default).
  - `label?: string`
  - `before?: string`
    Insert before the core group with this label; appended when the label is not found.
  - `items: NavItem[]`
- `interface PluginRequires`
  What `pnpm plugin check` verifies before an install, mirrored from the plugin's manifest.
- `interface PluginRoute`
  - `path: string`
    A path under the tier's router — `/approvals`, `/approvals/:id`.
  - `Component: LazyExoticComponent<ComponentType>`
    `lazy(() => import('./ui/pages/Something'))` and nothing else. A plugin's pages must not ride in the main bundle, and `tests/config/plugins.test.ts` checks the source for it.
  - `guard?: NavGuard`
    The SAME guard its nav item uses, so a link never points at a page its reader cannot open.
  - `tier?: PluginRouteTier`
    Default `shell` — inside `Layout`, signed in with a tenant.
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public'`
- `interface PluginSeedContext`
  Everything a plugin's `seedDemo` hook is given (`pnpm seed --demo`).
- `type PluginStructuredOptions = Omit< CallStructuredToolOptions<T>, 'model' \| 'maxTokens' > & { maxTokens?: number }`
  `callStructuredTool` minus what the runtime supplies.
- `type PluginToolLoopOptions = Omit< RunToolLoopOptions, 'model' \| 'maxTokens' \| 'approvals' \| 'runApproved' > & { maxTokens?: number }`
  `runToolLoop` minus what the runtime supplies.
- `interface Realtime`
  Everything a service needs to nudge: how to defer, and the hub binding. Built by `withAuth`.
- `function realtimeEvent( type: RealtimeEventType, tenantId: string, payload?: unknown ): RealtimeEvent`
- `async function recordActivity(db: Database, input: ActivityInput): Promise<void>`
- `async function recordUsage(db: Database, input: UsageInput): Promise<void>`
- `function requestCtx(c: AppContext): RequestCtx` — **used by** example-feature
  Build a plugin's request context from the kit's.
- `interface RequestCtx extends PluginContext, PluginAuth` — **used by** example-feature
  What a route handler is handed.
  - `readonly scope: AccessScope`
    Tenant-wide visibility scope (D29) — hand it to a predicate, never to a query as a tenant id.
  - `readonly groups: readonly GroupRef[]`
    The reader's groups in this organisation, each with the name of the TYPE it belongs to.
  - `readonly visibility: RequestVisibility`
    Read and write who may see one of this plugin's own rows (D29) — see `RequestVisibility`.
  - `guard(action: Actions, subject: Subjects): void`
    403 unless this role may `action` the `subject`. The KIND of thing, never the row.
  - `can(action: Actions, subject: Subjects): boolean`
    The same question without throwing — for branching, e.g. "may they also see the archived ones".
  - `hasFeature(name: string): boolean`
    `true` when this deployment ships the feature AND this organisation has it (D30).
  - `uuid(name: string): string`
    A `:id`-style parameter that must be a UUID. Anything else is a 404, never a database error — which also stops the route being a probe for which id shapes exist.
  - `valid<T>(target: 'json' \| 'query' \| 'param' \| 'form' \| 'header' \| 'cookie'): T`
    The value `validate('json' | 'query' | 'param', schema)` already parsed.
  - `page<T>( items: T[], total: number, query: PaginationQuery ): { items: T[]; pagination: PaginationMeta }`
    `{ items, pagination }` — the one list shape every consumer parses.
  - `defer(fn: () => Promise<unknown>): void`
    Run something that may outlive the response (an email, an audit write, a nudge). It goes through `waitUntil`, is never awaited on the response path, and LOGS rather than throws —…
  - `enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>`
    Hand work to `JOBS_QUEUE`. **A route never runs long work.** A missing binding throws rather than running inline, because silently doing the work in the request is how a 30-second…
  - `enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>`
  - `nudge(entity: string, id?: string): void`
    Tell this organisation's open tabs that a family of rows moved. `entity` IS the query-key family root, so declaring it once covers the socket wiring (D8).
  - `storage(): StorageService`
    R2, or a 503 `storage_not_configured` — loud, because a silently absent bucket loses bytes.
  - `durableObject<T extends Rpc.DurableObjectBranded \| undefined = undefined>( namespace: DurableObjectNamespace<T>, key?: string ): DurableObjectStub<T>`
    A per-tenant Durable Object stub. The plugin never spells the name; the prefix is structural.
  - `notFound(message?: string, code?: string): never`
  - `badRequest(message?: string, code?: string, details?: unknown): never`
  - `forbidden(message?: string, code?: string): never`
  - `unauthorized(message?: string): never`
  - `conflict(message?: string, code?: string, details?: unknown): never`
  - `unavailable(message?: string, code?: string): never`
  - `detached(): DetachedCtx`
    A snapshot of this context that outlives the handler (D31).
  - `readonly realtime: Realtime`
    The realtime handle, for a plugin service that takes `realtime?` the way the kit's do.
- `interface RequestVisibility`
  Reading and writing who may see one of a plugin's own rows (D29, D31).
  - `resolve( input: { visibility?: ResourceVisibility; groupIds?: readonly string[] } \| undefined ): Promise<SetResourceGroupsInput>`
    Validate what a CLIENT asked for, against the caller's own groups. Absent input keeps the default, which is tenant-wide; `'tenant'` always clears the grants, because leaving stale…
  - `set(kind: string, resourceId: string, input: SetResourceGroupsInput): Promise<string[]>`
    Write the row's `visibility` and replace its grants, in ONE transaction, through the registry entry this `kind` names. Answers the group ids that were actually stored.
  - `grantsFor(kind: string, resourceIds: readonly string[]): Promise<Map<string, GroupRef[]>>`
    Which groups each of these rows is shared with, in ONE query — so a badge strip on a list costs one extra round trip rather than one per row.
- `function requireFeature(feature: FeatureName)` — **used by** example-feature
- `interface ResourceGrantRow`
  One row of `grantsForResources`, before it is grouped by resource.
- `interface ScheduledTask`
- `interface SeedCtx extends Pick<PluginContext, 'db'>` — **used by** example-feature
  `pnpm seed --demo`, after the kit's own block.
  - `tenantId: string`
  - `ownerId: string`
  - `demoId: (key: string) => string`
  - `log: (line: string) => void`
- `interface ServerPlugin<S extends SharedPlugin = SharedPlugin>` — **used by** example-feature
  - `shared: S`
  - `requires?: PluginRequires`
  - `mounts?: readonly PluginMount[]`
    Spread into the mount table of `api/index.ts`; the prefix is `/api/<id>` by convention.
  - `apiPrefixes?: readonly string[]`
    Extra path prefixes the Worker owns, unioned into `API_PREFIXES` — so an unmatched path under one is a JSON 404 rather than `index.html`. Adding one ALSO means adding it to…
  - `jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }`
    `type` → handler, covering EXACTLY the job variants `shared.jobs` declares. Merged into the consumer's dispatch table; each handler gets its own DB client and awaits everything,…
  - `agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }`
    Agent definitions, one per key in `shared.agentKeys`.
  - `prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }`
    Prompt registry entries, one per key in `shared.promptKeys`.
  - `agentTools?: (ctx: AgentToolContext) => Tool[]`
    Tools added to every agent run, beside the kit's three knowledge tools. Bound to the run's access scope, so a plugin tool reads what its REQUESTER may read and nothing more.
  - `scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>`
    Cron expression → tasks, merged into `SCHEDULED_TASKS` (tasks on a cron the kit already runs are appended after the kit's). A cron the kit does NOT run must also be added to…
  - `grants?: Partial<Record<EffectiveRole, RoleGrant>>`
    Per-role CASL rules, applied after the kit's own matrix — additive, never a replacement.
  - `rlsExcludedTables?: readonly string[]`
    Plugin tables with no `tenant_id`, unioned into `RLS_EXCLUDED_TABLES` with a reason each.
  - `unscopedAllowlist?: Readonly<Record<string, string>>`
    Source files the cross-tenant allow-list scan may skip, keyed the way that test keys its own: a path relative to `apps/web/` (`src/plugins/<id>/…`) mapped to the REASON it is…
  - `visibilityResources?: readonly VisibilityResource[]`
    D29: rows of this plugin that a group may restrict. Read by `services/access.ts`.
  - `hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }`
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries (D31 decision 6): the analytics plugin reads `extensions.cubes` and friends from every installed plugin and narrows them with zod, failing loudly on…
- `interface SetResourceGroupsInput`
- `function sharedWithMyGroups( scope: AccessScope, junction: string, foreignKey: string, resourceId: SQL ): SQL`
  `exists (select 1 from <junction> j where j.<fk> = <resource>.id and j.group_id = any($ids))`.
- `interface StepCtx extends PluginContext`
  What a step body is handed: the base context, with a client that belongs to THIS step.
  - `name: string`
    The step's own name, so a log line can say which one it came from.
  - `realtime: StepRealtime`
    Nudges, collected and awaited before the step returns.
- `interface StepOptions`
  `step.do`'s options, narrowed to what the kit's own workflow uses.
  - `retries?: { limit: number delay: WorkflowSleepDuration \| number backoff?: 'constant' \| 'linear' \| 'exponential' }`
  - `timeout?: WorkflowSleepDuration \| number`
- `interface StepRealtime`
  - `realtime: Realtime`
    The `Realtime` a kit-shaped service takes as its trailing optional argument.
  - `settle(): Promise<void>`
    Await every send collected so far. Failures are swallowed — a nudge is never load-bearing.
  - `nudgeEntity(tenantId: string, entity: string, id?: string): Promise<void>`
  - `send(event: RealtimeEvent): Promise<void>`
  - `sendToUser(userId: string, event: RealtimeEvent): Promise<void>`
  - `sendToUsers(userIds: string[], event: RealtimeEvent): Promise<void>`
- `type Subjects = CoreSubject \| PluginSubject \| FeatureSubject`
- `type Tenant = typeof tenants.$inferSelect`
- `interface Tool<Input = unknown>` — **used by** example-feature
  A tool the model may call. `handler` runs it; a tool WITHOUT a handler is terminal (its input is the answer).
- `interface ToolApproval`
  An answered gate, as the loop consumes it — keyed by `toolCallId` in {@link RunToolLoopOptions.approvals}, built by the runtime from the resolved rows. The agent never assembles…
- `function toolCtx(ctx: AgentToolContext): ToolCtx` — **used by** example-feature
  Adapt the runtime's tool context. The only place a plugin's tools name a kit internal.
- `interface ToolCtx` — **used by** example-feature
  What `ServerPlugin.agentTools(ctx)` is handed, spelled as the plugin surface rather than as the runtime's internal shape.
  - `db: Database`
  - `config: PluginConfig`
  - `env: PluginBindings`
  - `scope: AccessScope`
  - `tenantId: string`
    The run's tenant — `scope.tenantId`, surfaced because every query needs it.
  - `maxDocumentChars?: number`
    The CALLER's budget for one document window, in characters. An agent run's is far larger than a chat turn's.
- `function toolInputSchema(schema: ZodType): JsonSchema`
  JSON Schema (draft-07, `$schema` stripped) for a tool input.
- `interface ToolLoopCheckpoint`
  Everything a later attempt needs to carry on where this one stopped. Deliberately symmetric: what {@link RunToolLoopOptions.onCheckpoint} hands you is exactly what {@link…
- `interface ToolLoopResult`
- `function traceChatClient( client: ChatClient, trace: TraceHandle, meta: TraceClientMeta, tracer?: Tracer ): ChatClient`
  Wrap a client so each call emits a `generation` on `trace`. Returns the client unchanged when tracing is off.
- `interface TraceHandle`
- `interface Tracer`
- `function tracingEnabled(tracer: Tracer): boolean`
  `true` when this request/run is actually shipping traces — cheap enough to branch on.
- `async function transaction<T>( db: PluginContext['db'], fn: (tx: PluginContext['db']) => Promise<T> ): Promise<T>`
  Run several writes as one transaction.
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the kit's. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the kit's own (D31). A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one…
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
- `type User = typeof users.$inferSelect`
- `function validate<T extends ZodSchema, Target extends keyof ValidationTargets>( target: Target, schema: T )` — **used by** example-feature
- `interface VisibilityResource`
  What it takes to be a resource a group can restrict.
- `async function withAgentTrace<T>( name: string, ctx: AgentTraceContext, fn: (trace: TraceHandle) => Promise<T> ): Promise<T>`
  Run `fn` inside one trace named `name`; the handle is passed so the body can wrap its client with `traceChatClient`. Output is recorded on success, the error on failure (then…
- `function workflowCtx( step: WorkflowStep, env: PluginBindings, config: AppConfig, logger: Logger ): WorkflowCtx`
  Adapt a Cloudflare `WorkflowStep` into the plugin surface.
- `interface WorkflowCtx`
  - `config: AppConfig`
  - `env: PluginBindings`
  - `logger: Logger`
  - `step<T extends Rpc.Serializable<T>>( name: string, options: StepOptions, fn: (ctx: StepCtx) => Promise<T> ): Promise<T>`
    Run one durable step. The name must be unique within the run — see rule 1 above; a repeat throws here rather than silently replaying.
  - `step<T extends Rpc.Serializable<T>>(name: string, fn: (ctx: StepCtx) => Promise<T>): Promise<T>`
    Run one durable step. The name must be unique within the run — see rule 1 above; a repeat throws here rather than silently replaying.
  - `waitForEvent( name: string, options: { type: string; timeout?: WorkflowSleepDuration \| number } ): Promise<unknown>`
    Park the instance until somebody sends this event, or the timeout expires.

### `@/plugins/api/peers`

The two escape hatches that read the whole installed set. Not on the barrel, on purpose.

> The two escape hatches that read the WHOLE installed set (D31).

- `function allTables(): AllTables` — **used by** example-feature
  The whole schema namespace, for a library that takes one (drizzle-cube's `createCubeApp({ schema })` is the case this exists for).
- `type AllTables = typeof schema`
  The merged drizzle schema: every kit table AND every installed plugin's.
- `function extensions(key: string): readonly unknown[]`
  Everything every installed plugin contributed under one `extensions` key (D31, decision 6).
- `function extensionSources(key: string): readonly string[]`
  Which plugins contributed under a key — for the error message when one of them fails to parse.

### `@/plugins/api/ui-wiring`

The only host module a plugin's `ui/index.ts` may import — it ships in the main bundle.

> The WIRING half of the UI kit (D31) — the only host module a plugin's `ui/index.ts` may import.

- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `const featureGuard: (feature: NavGuard, guard: NavGuard) => NavGuard` — **used by** example-feature
  `featureGuard(MY_FEATURE, { action: 'read', subject: 'Thing' })` → the flag AND the permission.
- `const isGuardList: (guard: NavGuard) => guard is readonly NavGuard[]`
  `Array.isArray` widens a `readonly T[]` to `any[]` rather than narrowing the union, so this.
- `type NavConfig = (NavItem \| NavGroup)[]`
- `interface NavGroup`
- `type NavGuard = \| 'admin' \| 'globalAdmin' \| { action: string; subject: string } \| { feature: string } \| readonly NavGuard[]` — **used by** example-feature
  Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics), a CASL `{ action, subject }` pair for per-page checks, a feature flag, or a list meaning AND. Strings,…
- `interface NavItem`
- `interface PluginNavGroup`
  A nav group, placed relative to a named core group ("Organisation" by default).
  - `label?: string`
  - `before?: string`
    Insert before the core group with this label; appended when the label is not found.
  - `items: NavItem[]`
- `interface PluginRoute`
  - `path: string`
    A path under the tier's router — `/approvals`, `/approvals/:id`.
  - `Component: LazyExoticComponent<ComponentType>`
    `lazy(() => import('./ui/pages/Something'))` and nothing else. A plugin's pages must not ride in the main bundle, and `tests/config/plugins.test.ts` checks the source for it.
  - `guard?: NavGuard`
    The SAME guard its nav item uses, so a link never points at a page its reader cannot open.
  - `tier?: PluginRouteTier`
    Default `shell` — inside `Layout`, signed in with a tenant.
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public'`
- `interface QuickLink`
- `interface TabConfig`
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>` — **used by** example-feature
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the kit's. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the kit's own (D31). A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one…
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
- `function useNavGuard(): (guard: NavGuard \| undefined) => boolean`

### `@/plugins/api/ui`

Components and hooks, for a lazy PAGE. Never for the UI entry.

> The COMPONENTS half of the UI kit (D31) — for a plugin's PAGES, never for its `ui/index.ts`.

- `function AccessBadge({ visibility, groups, className = '', }: { visibility: ResourceVisibility groups: GroupRef[] className?: string })`
  The read-only counterpart: a lock and the group names, for a list row.
- `function AccessPicker({ visibility, groupIds, available, onChange, tenantName, disabled = false, idPrefix = 'access', }: AccessPickerProps)`
- `interface AccessPickerProps`
- `function AlertModal({ isOpen, title, message, type = 'info', onClose }: AlertModalProps)`
  One-button acknowledgement on the `<dialog>` Modal.
- `const api: { get<T>(url: string, options?: ApiRequestOptions<T>): Promise<T>; post<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; put<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; patch<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>):… (truncated)` — **used by** example-feature
  GET → no error toast by default (queries render their own error state); mutations → toast.
- `class ApiError extends Error`
  Thrown for every non-2xx response. `body` is the parsed error envelope.
- `interface ApiRequestOptions<T = unknown> extends Omit<RequestInit, 'body'>`
- `interface Breadcrumb`
- `function ConfirmModal({ isOpen, title, message, confirmText = 'Confirm', cancelText = 'Cancel', confirmButtonClass = 'btn-primary', isLoading = false, onCancel, onConfirm, }: ConfirmModalProps)`
  Two-button confirmation on the `<dialog>` Modal.
- `function DocumentCard({ card, to, dense = false, footer }: DocumentCardProps)`
- `interface DocumentCardProps`
- `function DocumentLink({ to, title, meta, status, id }: DocumentLinkProps)`
- `function documentLinkProps(card: DocumentCardData): DocumentLinkProps`
  A `DocumentCard` as a one-liner: everything that survives the width, nothing that does not.
- `interface DocumentLinkProps`
- `function EmptyState({ icon: Icon, message, description, action, className = '', size = 'md', }: EmptyStateProps)` — **used by** example-feature
  "Nothing here yet" for lists and panels.
- `function EmptyStateCard(props: EmptyStateProps)`
  Panel-wrapped empty state for grid layouts.
- `function FieldError({ message, id }: { message?: string \| null; id?: string })`
  Inline field error. Forms are plain React + the `@rocketflare/shared` zod schema the server uses (`schema.safeParse(values)` before submit); this renders one issue's message.
- `function fieldErrorFor( issues: readonly { path: readonly PropertyKey[]; message: string }[] \| undefined, field: string ): string \| undefined`
  Pick the first zod issue for a field path out of a `safeParse` failure.
- `function formatBytes(bytes: number \| null \| undefined, fallback = '—'): string`
  "1.4 MB" — binary units, one decimal past KB, for file sizes on cards and detail rows.
- `function formatDate(value: Date \| null \| undefined, fallback = '—'): string`
- `function formatDateTime(value: Date \| null \| undefined, fallback = '—'): string`
- `function formatDuration(ms: number): string`
  `1m 12s`, `840ms` — how long something took, for run headers, steps and tool calls.
- `function initials(name: string \| null \| undefined, email?: string): string`
  "Olive Owner" → "OO"; falls back to the first letter of the email.
- `function LoadingIndicator({ size = 'md', centered = false, fullPage = false, className = '', }: LoadingIndicatorProps)`
  DaisyUI spinner in the primary colour.
- `function LogoMark({ className = 'w-7 h-7' }: { className?: string })`
  The Rocketflare mark — a rocket launching from a cloud — inlined so it needs no request and scales with `className`. The fills are the brand illustration colours, fixed on purpose…
- `function Modal({ open, onClose, title, children, actions, closeButton = true, className = '', }: ModalProps)`
  `<dialog>`-based modal: native focus trap, Escape and backdrop close, `aria-modal` for free. Controlled — the caller owns `open`. Falls back to the `open` attribute where…
- `interface ModalProps`
- `type NavGuard = \| 'admin' \| 'globalAdmin' \| { action: string; subject: string } \| { feature: string } \| readonly NavGuard[]`
  Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics), a CASL `{ action, subject }` pair for per-page checks, a feature flag, or a list meaning AND. Strings,…
- `function notifyUnauthorized(error: ApiError): void`
  Invoke the 401 handler. A stale session makes every in-flight query fail at once, so calls within the same tick are coalesced into ONE handler invocation. Called by `request()`…
- `function PageHeader({ title, description, breadcrumbs, badge, actions, className = '', }: PageHeaderProps)`
  Page title row: breadcrumbs, a modest title (no enormous headings), description, actions.
- `function PaginationControls({ pagination, onPageChange, isLoading = false, className = '', }: PaginationControlsProps)`
  "Showing X to Y of Z" + Previous/Next. Renders nothing for a single page.
- `function SearchInput({ value, onChange, placeholder = 'Search…', debounceMs = 300, className = '', size = 'md', 'aria-label': ariaLabel = 'Search', }: SearchInputProps)`
  Debounced search box with a clear button, for server-side search on index pages.
- `function SectionPanel({ title, description, actions, children, className = '', flush = false, }: SectionPanelProps)` — **used by** example-feature
  The default content container: `.surface-panel` with an optional header row.
- `function SectionPanelSkeleton({ rows = 4, className = '', }: { rows?: number className?: string })`
  Loading placeholder shaped like `SectionPanel`, so content does not jump on resolve.
- `function SettingInput({ id, label, description, value, onChange, placeholder, type = 'text', disabled, error, }: SettingInputProps)`
  Single-line input variant.
- `function SettingRow({ label, description, children, htmlFor, className = '', }: SettingRowProps)`
  "Label + description on the left, control on the right" — the settings-page row.
- `function SettingToggle({ id, label, description, checked, onChange, disabled, }: SettingToggleProps)`
  Toggle variant.
- `function setUnauthorizedHandler(handler: UnauthorizedHandler \| null): void`
  Register the global 401 handler. One handler; the last registration wins. Pass `null` to remove it. Phase 1 calls this from `AuthProvider` with the redirect-to-login behaviour.
- `function showToast(message: string, type: ToastType, duration?: number): void` — **used by** example-feature
  Show a toast from anywhere, inside or outside React.
- `default function SideNav({ items = navigationConfig, footer }: SideNavProps)` — **used by** example-feature
- `function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string })`
  Placeholder lines on their own, for panels that stay mounted while loading.
- `interface TabConfig`
- `function timeAgo(value: Date \| null \| undefined, fallback = 'never'): string`
  "3 hours ago" — for activity feeds and "last seen".
- `interface Toast`
- `function ToastContainer()`
  Bottom-right stack. Mount once.
- `type ToastType = 'success' \| 'error' \| 'warning' \| 'info'`
- `function URLTabs({ tabs, defaultTab, param = 'tab', className = '', actions, }: URLTabsProps)`
  Tabs whose active state lives in `?tab=`, so deep links and back/forward work.
- `function useAuth(): AuthContextValue` — **used by** example-feature
- `function useFeature(name: FeatureName): boolean`
  Is a feature on for this session (D30)? Reads `session.features` — the array the server resolved — and NEVER the ability: `manage all` covers `access` on every `Feature:` subject,…
- `function useGroups(typeId?: string, enabled = true)`
- `function useGroupTypes(enabled = true)`
- `function useMyGroups()`
  Every member may read their OWN groups — the profile list, and what the picker offers them.
- `function usePermissions()` — **used by** example-feature
- `function useTenancyMode(): TenancyMode`
  `'single'` hides OrgSwitcher, /select-tenant and org create/delete (D25).
- `const useToastStore: UseBoundStore<StoreApi<ToastStore>>`
- `function VisibilityModal({ open, onClose, name, visibility, groups, available, tenantName, isSaving = false, onSave, }: VisibilityModalProps)`
- `interface VisibilityModalProps`

### `@/plugins/types`

`ServerPlugin` and `UiPlugin` — the slots a plugin fills.

> The Worker half of a plugin (D31): what a plugin contributes to the server and to the UI.

- `type AnyServerPlugin = ServerPlugin<SharedPlugin>`
  The element type of the barrels — a plugin whose shared half is not narrowed.
- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]`
  One entry of the mount table in `api/index.ts`: prefix, router, optional gate.
- `interface PluginNavGroup`
  A nav group, placed relative to a named core group ("Organisation" by default).
  - `label?: string`
  - `before?: string`
    Insert before the core group with this label; appended when the label is not found.
  - `items: NavItem[]`
- `interface PluginRequires`
  What `pnpm plugin check` verifies before an install, mirrored from the plugin's manifest.
- `interface PluginRoute`
  - `path: string`
    A path under the tier's router — `/approvals`, `/approvals/:id`.
  - `Component: LazyExoticComponent<ComponentType>`
    `lazy(() => import('./ui/pages/Something'))` and nothing else. A plugin's pages must not ride in the main bundle, and `tests/config/plugins.test.ts` checks the source for it.
  - `guard?: NavGuard`
    The SAME guard its nav item uses, so a link never points at a page its reader cannot open.
  - `tier?: PluginRouteTier`
    Default `shell` — inside `Layout`, signed in with a tenant.
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public'`
- `interface PluginSeedContext`
  Everything a plugin's `seedDemo` hook is given (`pnpm seed --demo`).
- `interface ServerPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `requires?: PluginRequires`
  - `mounts?: readonly PluginMount[]`
    Spread into the mount table of `api/index.ts`; the prefix is `/api/<id>` by convention.
  - `apiPrefixes?: readonly string[]`
    Extra path prefixes the Worker owns, unioned into `API_PREFIXES` — so an unmatched path under one is a JSON 404 rather than `index.html`. Adding one ALSO means adding it to…
  - `jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }`
    `type` → handler, covering EXACTLY the job variants `shared.jobs` declares. Merged into the consumer's dispatch table; each handler gets its own DB client and awaits everything,…
  - `agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }`
    Agent definitions, one per key in `shared.agentKeys`.
  - `prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }`
    Prompt registry entries, one per key in `shared.promptKeys`.
  - `agentTools?: (ctx: AgentToolContext) => Tool[]`
    Tools added to every agent run, beside the kit's three knowledge tools. Bound to the run's access scope, so a plugin tool reads what its REQUESTER may read and nothing more.
  - `scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>`
    Cron expression → tasks, merged into `SCHEDULED_TASKS` (tasks on a cron the kit already runs are appended after the kit's). A cron the kit does NOT run must also be added to…
  - `grants?: Partial<Record<EffectiveRole, RoleGrant>>`
    Per-role CASL rules, applied after the kit's own matrix — additive, never a replacement.
  - `rlsExcludedTables?: readonly string[]`
    Plugin tables with no `tenant_id`, unioned into `RLS_EXCLUDED_TABLES` with a reason each.
  - `unscopedAllowlist?: Readonly<Record<string, string>>`
    Source files the cross-tenant allow-list scan may skip, keyed the way that test keys its own: a path relative to `apps/web/` (`src/plugins/<id>/…`) mapped to the REASON it is…
  - `visibilityResources?: readonly VisibilityResource[]`
    D29: rows of this plugin that a group may restrict. Read by `services/access.ts`.
  - `hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }`
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries (D31 decision 6): the analytics plugin reads `extensions.cubes` and friends from every installed plugin and narrows them with zod, failing loudly on…
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the kit's. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the kit's own (D31). A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one…
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.

### `@/db/schema/kit`

The build-time schema symbols. A `pgTable(...)` runs at module scope, so these cannot be injected.

> The schema kit (D31) — the build-time symbols a plugin's table file needs at MODULE scope.

- `const activityEvents: table "activity_events" { id, tenantId, userId, type, subjectType, subjectId, metadata, createdAt }`
- `const groupMembers: table "group_members" { tenantId, groupId, userId, createdAt }`
- `const groups: table "groups" { createdAt, updatedAt, id, tenantId, groupTypeId, name, description }`
- `const groupTypes: table "group_types" { createdAt, updatedAt, id, tenantId, name, description }`
- `function membershipIsolation()`
  `users` has no `tenant_id` — a user is global and belongs to MANY tenants through `tenant_users` — so it is scoped by MEMBERSHIP of the active tenant instead.
- `const RESOURCE_VISIBILITY_VALUES: readonly ["tenant", "groups"]`
  The values of a resource's `visibility` column (D29): `tenant` = every member of the organisation, `groups` = only the groups granted in that resource's junction table (plus the…
- `function tenantIsolation(table: string, column = sql`tenant_id`)`
  ONE policy predicate, shared by every table. Do not inline a copy per table: drizzle-kit diffs the rendered SQL text, so a stray space shows up as N spurious `ALTER POLICY`…
- `function tenantRef(tenants: { id: AnyPgColumn })`
  `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
- `const tenants: table "tenants" { createdAt, updatedAt, id, name, slug, status, seedDataCreated, lastAccessedAt }`
- `const tenantUsers: table "tenant_users" { tenantId, userId, role, joinedAt, invitedByUserId }`
- `function timestamps()`
  `created_at` / `updated_at` as `timestamptz`, both defaulting to now(). Spread into a table.
- `const users: table "users" { createdAt, updatedAt, id, email, name, avatarUrl, isGlobalAdmin, emailVerifiedAt, lastLoginAt, blockedAt }`

### `@rocketflare/shared/plugins/api`

What a plugin's CONTRACT module imports: the error envelope, pagination, `SharedPlugin`.

> The shared plugin API (D31) — what a plugin's CONTRACT module imports from the kit.

- `type Actions = (typeof ACTIONS)[number]`
- `type AgentKeyOf = NonNullable<DeclaredBy<S, 'agentKeys'>>[number]`
  The agent keys one plugin declares — what its `ServerPlugin.agents` must cover, exhaustively.
- `type ApiErrorBody = z.infer<typeof apiErrorSchema>`
- `const apiErrorSchema: z.ZodObject<{ error: z.ZodString; statusCode: z.ZodNumber; code: z.ZodOptional<z.ZodString>; details: z.ZodOptional<z.ZodUnknown>; }, "strip", z.ZodTypeAny, { error: string; statusCode: number; code?: string \| undefined; details?: unknown; }, { error: string; statusCode: number; code?: string \| unde… (truncated)`
  The ONE error envelope every API response uses — from `app.onError`, `notFound`, the zValidator hook, and `ApiError` thrown in routes. The UI's `api-client.ts` parses this into…
- `type DeclaredBy = Extract<P, Record<K, unknown>> extends infer Declaring ? Declaring extends Record<K, unknown> ? Declaring[K] : never : never`
  The value of an OPTIONAL `SharedPlugin` field across the whole barrel, skipping the plugins that do not declare it.
- `const ERROR_CODES: { readonly validationFailed: "validation_failed"; readonly unauthorized: "unauthorized"; readonly sessionExpired: "session_expired"; readonly forbidden: "forbidden"; readonly notFound: "not_found"; readonly conflict: "conflict"; readonly rateLimited: "rate_limited"; readonly pendingApproval: "pendin… (truncated)`
  Well-known `code` values shared by API and UI. Extend per app.
- `type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
- `interface FeatureDefinition`
- `type FeatureFlagState = z.infer<typeof featureFlagStateSchema>`
- `type FeatureKeyOf = Extract< keyof NonNullable<DeclaredBy<S, 'features'>>, string >`
  The feature keys one plugin declares (the keys of its `features` record).
- `type FeatureRolloutUnit = z.infer<typeof featureRolloutUnitSchema>`
- `type GroupRef = z.infer<typeof groupRefSchema>`
- `function isPluginId(value: string): boolean`
- `type JobInput = z.infer<typeof jobInputSchema>`
- `type JobOf = Extract<JobEnvelope, { type: T }>`
  The envelope narrowed to one `type` — what a handler receives.
- `type JobType = JobEnvelope['type']`
  Every job type this app knows, derived from the variants rather than kept beside them.
- `type JobTypeOf = TypeOf< NonNullable<DeclaredBy<S, 'jobs'>>[number] >['type']`
  The job types one plugin declares — what its `ServerPlugin.jobHandlers` must cover.
- `type JobVariant = ZodDiscriminatedUnionOption<'type'>`
  One job envelope variant: a zod object whose `type` is the discriminant. Spelled as zod's own discriminated-union option type, so a variant that would not compose into…
- `type MembershipRole = z.infer<typeof membershipRoleSchema>`
- `function paginatedResponse<T extends z.ZodTypeAny>(item: T)`
  `paginatedResponse(itemSchema)` → `{ items: Item[], pagination: PaginationMeta }`
- `function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta`
- `type PaginationMeta = z.infer<typeof paginationMetaSchema>`
- `const paginationMetaSchema: z.ZodObject<{ page: z.ZodNumber; pageSize: z.ZodNumber; total: z.ZodNumber; totalPages: z.ZodNumber; }, "strip", z.ZodTypeAny, { page: number; pageSize: number; total: number; totalPages: number; }, { page: number; pageSize: number; total: number; totalPages: number; }>`
- `type PaginationQuery = z.infer<typeof paginationQuerySchema>`
- `const paginationQuerySchema: z.ZodObject<{ page: z.ZodDefault<z.ZodNumber>; pageSize: z.ZodDefault<z.ZodNumber>; }, "strip", z.ZodTypeAny, { page: number; pageSize: number; }, { page?: number \| undefined; pageSize?: number \| undefined; }>`
  Page-based pagination (page-based). Query: `?page=1&pageSize=25`.
- `const PLUGIN_ID_RE: RegExp`
  `^[a-z][a-z0-9-]*$` and never containing `rocketflare`: a plugin is written in the kit's vocabulary so `scripts/rename.mjs` can translate it into a renamed app on the way in, and…
- `function pluginNamespace(id: string): string`
  `<id>:` — the prefix every query-key root and demo-seed id a plugin owns must carry.
- `type PromptKeyOf = NonNullable<DeclaredBy<S, 'promptKeys'>>[number]`
  The prompt keys one plugin declares — what its `ServerPlugin.prompts` must cover.
- `type RealtimeEvent = z.infer<typeof realtimeEventSchema>`
- `type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>`
- `type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>`
- `interface SharedPlugin`
  - `readonly id: string`
    Matches `PLUGIN_ID_RE`; the namespace for everything below.
  - `readonly label: string`
    Human name, for the plugin list and the install plan.
  - `readonly version?: string`
    The plugin's own semver, mirrored from its `rocketflare-plugin.json`.
  - `readonly agentKeys?: readonly string[]`
    Agent keys this plugin registers — `AGENT_KEYS = [...CORE_AGENT_KEYS, ...plugins]`. Declared here rather than server-side because the UI and the CLI validate agent input against…
  - `readonly promptKeys?: readonly string[]`
    Prompt registry keys this plugin owns; `ServerPlugin.prompts` must cover exactly these.
  - `readonly jobs?: readonly JobVariant[]`
    Job envelope variants as DATA: `jobInputSchema` is a discriminated union over `[...CORE_JOB_VARIANTS, ...plugin variants]`. Namespace every `type` with the plugin's id…
  - `readonly subjects?: readonly string[]`
    CASL subjects this plugin adds, unioned into `Subjects`. A subject is a NOUN the plugin owns (`Order`), and the rules that grant it live in `ServerPlugin.grants`.
  - `readonly features?: Readonly<Record<string, FeatureDefinition>>`
    Feature-flag definitions keyed by flag key (D30), merged into `FEATURE_FLAGS`. A flag is configuration, not a permission: gate with `hasFeature(auth.features, …)`, never with CASL.
  - `readonly config?: ZodRawShape`
    Extra `[vars]` / secrets, merged into the Worker's config schema (`apps/web/src/config.ts`). A zod raw shape rather than a whole object so the kit's schema stays one schema.
  - `readonly realtimeRoots?: readonly string[]`
    Query-key roots that `access.changed` should invalidate (D29): a plugin whose rows carry `visibility` has to be re-fetched when somebody's group membership moves under them.
- `type SubjectOf = NonNullable<DeclaredBy<S, 'subjects'>>[number]`
  The CASL subjects one plugin declares.
- `type Subjects = CoreSubject \| PluginSubject \| FeatureSubject`

### `@rocketflare/shared/plugins/contract`

The plugin API version itself.

> The plugin API version (D31) — which SURFACE a plugin compiles against, as two integers.

- `const PLUGIN_API: { readonly current: 1; readonly minSupported: 1; }`
  The plugin API version this kit provides, and the oldest one it still honours.
- `interface PluginApiVersions`
  `{ current, minSupported }` — what `pluginApiProblem` compares a plugin's declaration against.

### `'../api' (apps/cli/src/plugins/api.ts)`

The CLI half: the one `fetch` site, the exit codes, the output helpers.

> The CLI plugin API (D31) — what a plugin's command module imports from the kit.

- `type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>`
  `action()` in `cli.ts`: builds the context from the global options and maps any error.
- `type AnyCliPlugin = CliPlugin<SharedPlugin>`
- `interface ApiClient`
- `interface ApiResponse<T>`
- `class CliApiError extends CliError`
- `class CliError extends Error`
- `interface CliPlugin<S extends SharedPlugin = SharedPlugin>` — **used by** example-feature
  - `shared: S`
  - `register(program: Command, action: ActionWrapper): void`
    Add `program.command(...)` entries. The top-level command name is the plugin's id.
- `interface Column<Row>`
- `interface CommandContext` — **used by** example-feature
- `interface ContextOptions`
- `const EXIT_ERROR: 1`
- `const EXIT_FORBIDDEN: 3`
- `const EXIT_NOT_LOGGED_IN: 2`
- `const EXIT_OK: 0`
  CLI error types and the exit-code mapping (D26): 0 ok · 1 error · 2 not logged in · 3 forbidden. Commands throw; `cli.ts` catches once, prints once, and sets `process.exitCode`.
- `function exitCodeForStatus(status: number): number`
- `function formatCell(value: unknown): string`
- `function formatDate(value: Date \| string \| null \| undefined): string` — **used by** example-feature
  `2026-09-01 07:54` in local time, or `-` for null.
- `function formatJson(value: unknown): string`
- `function formatPagination(meta: { page: number totalPages: number total: number pageSize: number }): string` — **used by** example-feature
  `Page 2/5 · 113 items` — footer for paginated lists.
- `class NotLoggedInError extends CliError`
- `type OpenLike = (url: string) => Promise<unknown>`
- `interface Output`
- `function publicClient(ctx: CommandContext): ApiClient`
  An unauthenticated client (health checks).
- `type QueryValue = string \| number \| boolean \| undefined \| null`
- `function renderTable<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string` — **used by** example-feature
  Left-aligned columns separated by two spaces; header in bold; `-` for null/undefined.
- `interface RequestOptions<T>`
- `function requireClient(ctx: CommandContext): ApiClient` — **used by** example-feature
  An authenticated client, or `NotLoggedInError` (exit 2) when no key is configured.

### `'./types' (apps/cli/src/plugins/types.ts)`

`CliPlugin` and the `action()` wrapper it registers with.

> The CLI half of a plugin (D31).

- `type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>`
  `action()` in `cli.ts`: builds the context from the global options and maps any error.
- `type AnyCliPlugin = CliPlugin<SharedPlugin>`
- `interface CliPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `register(program: Command, action: ActionWrapper): void`
    Add `program.command(...)` entries. The top-level command name is the plugin's id.

### `@testkit/integration`

The harness: a real database, the real Hono app, real bindings-shaped stubs, the provider tree.

> `@testkit/integration` — the host's test harness, as a DECLARED entry (D31).

- `function bearerHeader(key: string): Record<string, string>`
- `async function cleanDatabase(db: Database): Promise<void>`
  TRUNCATE every table in `public` (drizzle's bookkeeping lives in schema `drizzle`).
- `function createExecutionContext(): TestExecutionContext`
- `async function createTestApiKey( db: Database, tenantId: string, userId: string, overrides: Partial<Omit<NewApiKey, 'keyHash' \| 'keyPrefix'>> = {} )`
  A tenant API key created by `userId` (who must be a member). Returns the plaintext `key` for an `Authorization: Bearer` header plus the stored row.
- `function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv` — **used by** example-feature
  A fresh env per call (KV and queue state are not shared between calls). Vars come from process.env with .env.test-compatible defaults; pass `overrides` to change any of them.
- `function createTestGlobalAdmin(db: Database, overrides: Partial<NewUser> = {})`
  A platform staff account (`users.isGlobalAdmin`), the gate for `/api/admin/*`.
- `function createTestQueryClient()`
  A fresh client with retries off so failing queries settle immediately.
- `async function createTestSession( db: Database, userId: string, tenantId?: string \| null, options: { expiresInDays?: number; ip?: string; userAgent?: string } = {} ): Promise<string>` — **used by** example-feature
  A cookie session for `userId` (optionally pinned to `tenantId`). Returns the COOKIE VALUE — the raw token; the row stores only `hashToken(token)`.
- `async function createTestTenant(db: Database, overrides: Partial<NewTenant> = {})` — **used by** example-feature
- `async function createTestTenantWithUser( db: Database, role: MembershipRole = 'owner', userOverrides: Partial<NewUser> = {}, tenantOverrides: Partial<NewTenant> = {} )`
  Tenant + one member in one call (default `owner`).
- `async function createTestUser(db: Database, overrides: Partial<NewUser> = {})` — **used by** example-feature
- `async function dispatchScheduled( cron: string, env: AppBindings, ctx: Pick<ExecutionContext, 'waitUntil'>, registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS ): Promise<TaskReport[]>`
  Runs every task registered for `cron` and returns a per-task report (used by tests).
- `function errorResponse(status: number, error = 'Error', code?: string)`
- `const IDS: { user: string; otherUser: string; tenant: string; otherTenant: string; }`
- `async function json<T = unknown>(res: Response): Promise<T>` — **used by** example-feature
- `function jsonResponse(body: unknown, status = 200)`
  JSON `Response` helper for `vi.stubGlobal('fetch', …)`.
- `async function linkUserToTenant( db: Database, userId: string, tenantId: string, role: MembershipRole = 'member', invitedByUserId: string \| null = null )` — **used by** example-feature
  Membership row. `support` is allowed here because fixtures must reach states only /admin mints.
- `function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse` — **used by** example-feature
  A signed-in owner of Acme by default. Pass `tenant: null` for the "no active tenant" states; `permissions` follows `tenant.role`/`user.isGlobalAdmin` unless given explicitly.
- `function makeTenant(overrides: Partial<TenantSummary> = {}): TenantSummary`
- `function makeUser(overrides: Partial<User> = {}): User` — **used by** example-feature
- `const notFoundResponse: () => Response`
- `function paged<T>(items: T[], pageSize = 25)`
  `{ items, pagination }` for a one-page list response.
- `interface RecordedMessage<T = unknown>`
- `function renderWithProviders( ui: ReactElement, { route = '/', queryClient = createTestQueryClient(), session, ...options }: ProviderOptions = {} )` — **used by** example-feature
- `async function request( path: string, init: RequestInit = {}, options: RequestOptions = {} ): Promise<Response>` — **used by** example-feature
- `function requestBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>, key: string)`
  Body of the JSON request made to `"METHOD /path"`, or undefined if never called.
- `interface RequestOptions`
- `type RouteTable = Record< string, Response \| unknown \| ((init: RequestInit \| undefined, url: URL) => Response \| unknown) >`
  `{ 'GET /api/members': handler }`; the method defaults to GET when omitted from the key.
- `function rulesFor( role: MembershipRole \| null, isGlobalAdmin = false, features: string[] = [] )` — **used by** example-feature
  Packed rules EXACTLY as the server emits them for this role (same matrix, same packer).
- `const SCHEDULED_TASKS: Record<string, ScheduledTask[]>`
  Core tasks plus every installed plugin's (D31). A plugin naming a cron the kit already runs APPENDS to it — each task is try/caught on its own, so a plugin's failure cannot stop…
- `interface ScheduledTask`
- `const SESSION_COOKIE_NAME: "__Host-session"`
  The login cookie. `middleware/csrf.ts` re-exports this so the CSRF check names the same cookie.
- `function sessionCookieHeader(token: string): Record<string, string>` — **used by** example-feature
  `{ Cookie }` header for a token from `createTestSession`.
- `function setupTestDatabase(): Database` — **used by** example-feature
  Shared pooled handle for fixtures/assertions (max 5 connections per fork).
- `function stubFetch(routes: RouteTable = {})`
  Stub `fetch` from a route table. Keys are `"METHOD /path"` (path compared without the query string); unmatched requests 404 with the shared envelope. Returns the mock for call…
- `function stubHealthFetch(info: Record<string, unknown> = {})`
  Stub `fetch` so `/api/health` answers with the given app info; everything else 404s.
- `function stubs(env: TestEnv)` — **used by** example-feature
  Typed access to the in-memory stubs behind a `createTestEnv()` env.
- `function stubSessionFetch(session: SessionResponse \| null)`
  Layer a `/auth/session` answer over whatever `fetch` the test already installed.
- `interface TaskReport`
- `function testDatabaseUrl(): string`
- `type TestEnv = AppBindings & { DATABASE_URL: string [secret: string]: unknown }`
  Structurally `Cloudflare.Env` so it can be passed straight to `app.request`, `queue()` and `scheduled()`. The bindings are in-memory stubs cast to the platform types; reach the…
- `interface TestSeed`
  Plain, JSON-serialisable — vitest's `provide()` requires it.
- `const unauthorizedResponse: () => Response`
- `function uniqueId(): string`
  Unique suffix for parallel-safe fixtures.
- `async function waitOnExecutionContext(ctx: TestExecutionContext): Promise<void>`
  Await everything passed to `waitUntil`, including promises enqueued while draining.

### `@testkit/unit`

Builders for the context family, for tests that never touch data.

> `@testkit/unit` — builders for the plugin context family (D31).

- `interface CronCtxOptions extends BaseOptions`
- `type FakeRequestCtx = RequestCtx & { readonly deferred: ReadonlyArray<() => Promise<unknown>> settle(): Promise<void> }`
  What a fake request context carries beyond the real one: the deferred work it collected.
- `type FakeWorkflowCtx = WorkflowCtx & { readonly recorded: ReturnType<typeof createFakeWorkflowStep> }`
  The fake step recorder, so a test can assert the NAMES a run asked for and their order.
- `function makeCronCtx(options: CronCtxOptions): CronCtx`
- `function makeJobCtx(options: BaseOptions): JobCtx`
  One queue message's context, through the kit's own `jobCtx` adapter.
- `function makeRequestCtx(options: RequestCtxOptions): FakeRequestCtx`
  A `RequestCtx` with no request behind it.
- `function makeToolCtx(options: ToolCtxOptions): ToolCtx` — **used by** example-feature
  What `ServerPlugin.agentTools(ctx)` is handed, through the kit's own `toolCtx` adapter.
- `function makeWorkflowCtx(options: WorkflowCtxOptions): FakeWorkflowCtx`
  A `WorkflowCtx` over a recording step.
- `interface RequestCtxOptions extends BaseOptions`
- `interface ToolCtxOptions extends BaseOptions`
- `interface WorkflowCtxOptions extends BaseOptions`

## Who uses what

Derived from the imports of the plugins installed **in this checkout** — so it answers "what does
removing this cost" for this app, and it changes when somebody installs a plugin. An unannotated
member is not a dead one: only the reference plugin ships with the kit, so most of the surface has
no user here and never will have until an app installs something that needs it. Interface members
carry no annotation at all, because there is no import to observe.

| Member | Entry | Used by |
|---|---|---|
| `Database` | `@/plugins/api` | example-feature |
| `HookCtx` | `@/plugins/api` | example-feature |
| `JobCtx` | `@/plugins/api` | example-feature |
| `JobHandler` | `@/plugins/api` | example-feature |
| `RequestCtx` | `@/plugins/api` | example-feature |
| `SeedCtx` | `@/plugins/api` | example-feature |
| `ServerPlugin` | `@/plugins/api` | example-feature |
| `Tool` | `@/plugins/api` | example-feature |
| `ToolCtx` | `@/plugins/api` | example-feature |
| `createRouter` | `@/plugins/api` | example-feature |
| `defineTool` | `@/plugins/api` | example-feature |
| `jobCtx` | `@/plugins/api` | example-feature |
| `requestCtx` | `@/plugins/api` | example-feature |
| `requireFeature` | `@/plugins/api` | example-feature |
| `toolCtx` | `@/plugins/api` | example-feature |
| `validate` | `@/plugins/api` | example-feature |
| `allTables` | `@/plugins/api/peers` | example-feature |
| `NavGuard` | `@/plugins/api/ui-wiring` | example-feature |
| `UiPlugin` | `@/plugins/api/ui-wiring` | example-feature |
| `featureGuard` | `@/plugins/api/ui-wiring` | example-feature |
| `EmptyState` | `@/plugins/api/ui` | example-feature |
| `SectionPanel` | `@/plugins/api/ui` | example-feature |
| `SideNav` | `@/plugins/api/ui` | example-feature |
| `api` | `@/plugins/api/ui` | example-feature |
| `showToast` | `@/plugins/api/ui` | example-feature |
| `useAuth` | `@/plugins/api/ui` | example-feature |
| `usePermissions` | `@/plugins/api/ui` | example-feature |
| `CliPlugin` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `CommandContext` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `formatDate` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `formatPagination` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `renderTable` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `requireClient` | `'../api' (apps/cli/src/plugins/api.ts)` | example-feature |
| `SharedPlugin` | `'./types' (apps/cli/src/plugins/types.ts)` | example-feature |
| `createTestEnv` | `@testkit/integration` | example-feature |
| `createTestSession` | `@testkit/integration` | example-feature |
| `createTestTenant` | `@testkit/integration` | example-feature |
| `createTestUser` | `@testkit/integration` | example-feature |
| `json` | `@testkit/integration` | example-feature |
| `linkUserToTenant` | `@testkit/integration` | example-feature |
| `makeSession` | `@testkit/integration` | example-feature |
| `makeUser` | `@testkit/integration` | example-feature |
| `renderWithProviders` | `@testkit/integration` | example-feature |
| `request` | `@testkit/integration` | example-feature |
| `rulesFor` | `@testkit/integration` | example-feature |
| `sessionCookieHeader` | `@testkit/integration` | example-feature |
| `setupTestDatabase` | `@testkit/integration` | example-feature |
| `stubs` | `@testkit/integration` | example-feature |
| `makeToolCtx` | `@testkit/unit` | example-feature |

## Surface ledger

The machine-readable snapshot, and the only part of this file the generator reads back. Every
member is one line; the version is the number the snapshot was taken at. A change or a removal
below with that number unchanged is what fails the gate, which is the whole mechanism by which the
version means something rather than being a claim.

```text
plugin-api 1
@/plugins/api :: type :: AbilityCheck :: type AbilityCheck = (action: Actions, subject: Subjects) => boolean
@/plugins/api :: interface :: AccessScope :: interface AccessScope
@/plugins/api :: type :: Actions :: type Actions = (typeof ACTIONS)[number]
@/plugins/api :: interface :: ActivityInput :: interface ActivityInput
@/plugins/api :: function :: agentCtx :: function agentCtx<Input>(ctx: AgentContext<Input>): AgentCtx<Input>
@/plugins/api :: interface :: AgentCtx :: interface AgentCtx<Input = unknown>
@/plugins/api :: member :: AgentCtx.db :: db: Database
@/plugins/api :: member :: AgentCtx.config :: config: PluginConfig
@/plugins/api :: member :: AgentCtx.env :: env: PluginBindings
@/plugins/api :: member :: AgentCtx.logger :: logger: AgentContext['logger']
@/plugins/api :: member :: AgentCtx.tenantId :: tenantId: string
@/plugins/api :: member :: AgentCtx.runId :: runId: string
@/plugins/api :: member :: AgentCtx.userId :: userId: string | null
@/plugins/api :: member :: AgentCtx.input :: input: Input
@/plugins/api :: member :: AgentCtx.tools :: tools: Tool[]
@/plugins/api :: member :: AgentCtx.prompt :: prompt(vars?: Record<string, string | undefined>): Promise<string>
@/plugins/api :: member :: AgentCtx.step :: step( key: string, label: string, status: 'running' | 'done' | 'error', detail?: string ): Promise<void>
@/plugins/api :: member :: AgentCtx.checkCancelled :: checkCancelled(): Promise<void>
@/plugins/api :: member :: AgentCtx.once :: once<T>(key: string, fn: () => Promise<T>): Promise<T>
@/plugins/api :: member :: AgentCtx.toolLoop :: toolLoop(options: PluginToolLoopOptions): Promise<ToolLoopResult>
@/plugins/api :: member :: AgentCtx.structured :: structured<T>(options: PluginStructuredOptions<T>): Promise<T>
@/plugins/api :: interface :: AgentTraceContext :: interface AgentTraceContext extends Omit<TraceParams, 'name'>
@/plugins/api :: class :: AiNotConfiguredError :: class AiNotConfiguredError extends ServiceUnavailableError
@/plugins/api :: type :: AnyServerPlugin :: type AnyServerPlugin = ServerPlugin<SharedPlugin>
@/plugins/api :: type :: AnyUiPlugin :: type AnyUiPlugin = UiPlugin<SharedPlugin>
@/plugins/api :: type :: AppRouter :: type AppRouter = Hono<AppEnv>
@/plugins/api :: function :: createRouter :: function createRouter(): Hono<AppEnv>
@/plugins/api :: function :: createStepRealtimeFor :: function createStepRealtimeFor(env: HubEnv): StepRealtime
@/plugins/api :: function :: cronCtx :: function cronCtx(ctx: TaskContext): CronCtx
@/plugins/api :: interface :: CronCtx :: interface CronCtx extends PluginContext, BackgroundMethods
@/plugins/api :: member :: CronCtx.waitUntil :: waitUntil(promise: Promise<unknown>): void
@/plugins/api :: type :: Database :: type Database = PostgresJsDatabase<typeof schema>
@/plugins/api :: interface :: DatabaseHandle :: interface DatabaseHandle
@/plugins/api :: function :: defineTool :: function defineTool<Input>(tool: Tool<Input>): Tool<Input>
@/plugins/api :: interface :: DetachedCtx :: interface DetachedCtx extends PluginContext
@/plugins/api :: member :: DetachedCtx.tenantId :: tenantId: string
@/plugins/api :: member :: DetachedCtx.userId :: userId: string
@/plugins/api :: member :: DetachedCtx.role :: role: PluginAuth['role']
@/plugins/api :: member :: DetachedCtx.isAdmin :: isAdmin: boolean
@/plugins/api :: member :: DetachedCtx.features :: features: readonly string[]
@/plugins/api :: member :: DetachedCtx.scope :: scope: AccessScope
@/plugins/api :: member :: DetachedCtx.groups :: groups: readonly GroupRef[]
@/plugins/api :: class :: DuplicateStepNameError :: class DuplicateStepNameError extends Error
@/plugins/api :: function :: durableObject :: function durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>( namespace: DurableObjectNamespace<T>, tenantId: string, key?: string ): DurableObjectStub<T>
@/plugins/api :: function :: hasFeature :: function hasFeature(auth: Pick<PluginAuth, 'features'>, name: string): boolean
@/plugins/api :: interface :: HookCtx :: interface HookCtx extends Pick<PluginContext, 'db'>
@/plugins/api :: member :: HookCtx.tenant :: tenant: Tenant
@/plugins/api :: member :: HookCtx.tenantId :: tenantId: string
@/plugins/api :: member :: HookCtx.userId :: userId: string | null
@/plugins/api :: member :: HookCtx.features :: features: readonly string[]
@/plugins/api :: function :: isAdminLevel :: function isAdminLevel(session: RoleView): boolean
@/plugins/api :: function :: isGlobalAdmin :: function isGlobalAdmin(session: RoleView): boolean
@/plugins/api :: function :: isOwnerLevel :: function isOwnerLevel(session: RoleView): boolean
@/plugins/api :: function :: jobCtx :: function jobCtx(ctx: JobContext): JobCtx
@/plugins/api :: interface :: JobCtx :: interface JobCtx extends PluginContext, BackgroundMethods
@/plugins/api :: type :: JobEnvelope :: type JobEnvelope = z.infer<typeof jobEnvelopeSchema>
@/plugins/api :: type :: JobHandler :: type JobHandler = ( job: Extract<JobEnvelope, { type: T }>, ctx: JobContext ) => Promise<void>
@/plugins/api :: type :: JobInput :: type JobInput = z.infer<typeof jobInputSchema>
@/plugins/api :: type :: JobOf :: type JobOf = Extract<JobEnvelope, { type: T }>
@/plugins/api :: type :: JobType :: type JobType = JobEnvelope['type']
@/plugins/api :: type :: Logger :: type Logger = pino.Logger
@/plugins/api :: type :: MembershipRole :: type MembershipRole = z.infer<typeof membershipRoleSchema>
@/plugins/api :: const :: noopTracer :: const noopTracer: Tracer
@/plugins/api :: function :: notify :: async function notify(db: Database, input: NotifyInput, realtime?: Realtime): Promise<void>
@/plugins/api :: interface :: NotifyInput :: interface NotifyInput
@/plugins/api :: function :: notifyMany :: async function notifyMany( db: Database, userIds: string[], input: Omit<NotifyInput, 'userId'>, realtime?: Realtime )
@/plugins/api :: function :: nudge :: function nudge(rt: Realtime | undefined, event: RealtimeEvent): void
@/plugins/api :: function :: nudgeEntity :: function nudgeEntity( realtime: Realtime | undefined, tenantId: string, entity: string, id?: string ): void
@/plugins/api :: function :: nudgeUser :: function nudgeUser(rt: Realtime | undefined, userId: string, event: RealtimeEvent): void
@/plugins/api :: function :: nudgeUsers :: function nudgeUsers( rt: Realtime | undefined, userIds: string[], event: RealtimeEvent ): void
@/plugins/api :: function :: pageWindow :: function pageWindow(query: PaginationQuery): { limit: number; offset: number }
@/plugins/api :: type :: PluginAgent :: type PluginAgent = AgentDefinition<Input, Output>
@/plugins/api :: interface :: PluginAuth :: interface PluginAuth
@/plugins/api :: member :: PluginAuth.user :: user: User
@/plugins/api :: member :: PluginAuth.userId :: userId: string
@/plugins/api :: member :: PluginAuth.tenantId :: tenantId: string
@/plugins/api :: member :: PluginAuth.role :: role: MembershipRole | null
@/plugins/api :: member :: PluginAuth.isAdmin :: isAdmin: boolean
@/plugins/api :: member :: PluginAuth.isOwner :: isOwner: boolean
@/plugins/api :: member :: PluginAuth.isGlobalAdmin :: isGlobalAdmin: boolean
@/plugins/api :: member :: PluginAuth.features :: features: readonly string[]
@/plugins/api :: type :: PluginBindings :: type PluginBindings = AppBindings
@/plugins/api :: type :: PluginConfig :: type PluginConfig = AppConfig
@/plugins/api :: interface :: PluginContext :: interface PluginContext
@/plugins/api :: member :: PluginContext.db :: db: Database
@/plugins/api :: member :: PluginContext.config :: config: PluginConfig
@/plugins/api :: member :: PluginContext.logger :: logger: PluginLogger
@/plugins/api :: member :: PluginContext.env :: env: PluginBindings
@/plugins/api :: type :: PluginLogger :: type PluginLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
@/plugins/api :: type :: PluginMount :: type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]
@/plugins/api :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/api :: member :: PluginNavGroup.label :: label?: string
@/plugins/api :: member :: PluginNavGroup.before :: before?: string
@/plugins/api :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/api :: interface :: PluginRequires :: interface PluginRequires
@/plugins/api :: interface :: PluginRoute :: interface PluginRoute
@/plugins/api :: member :: PluginRoute.path :: path: string
@/plugins/api :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/api :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/api :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/api :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public'
@/plugins/api :: interface :: PluginSeedContext :: interface PluginSeedContext
@/plugins/api :: type :: PluginStructuredOptions :: type PluginStructuredOptions = Omit< CallStructuredToolOptions<T>, 'model' | 'maxTokens' > & { maxTokens?: number }
@/plugins/api :: type :: PluginToolLoopOptions :: type PluginToolLoopOptions = Omit< RunToolLoopOptions, 'model' | 'maxTokens' | 'approvals' | 'runApproved' > & { maxTokens?: number }
@/plugins/api :: interface :: Realtime :: interface Realtime
@/plugins/api :: function :: realtimeEvent :: function realtimeEvent( type: RealtimeEventType, tenantId: string, payload?: unknown ): RealtimeEvent
@/plugins/api :: function :: recordActivity :: async function recordActivity(db: Database, input: ActivityInput): Promise<void>
@/plugins/api :: function :: recordUsage :: async function recordUsage(db: Database, input: UsageInput): Promise<void>
@/plugins/api :: function :: requestCtx :: function requestCtx(c: AppContext): RequestCtx
@/plugins/api :: interface :: RequestCtx :: interface RequestCtx extends PluginContext, PluginAuth
@/plugins/api :: member :: RequestCtx.scope :: readonly scope: AccessScope
@/plugins/api :: member :: RequestCtx.groups :: readonly groups: readonly GroupRef[]
@/plugins/api :: member :: RequestCtx.visibility :: readonly visibility: RequestVisibility
@/plugins/api :: member :: RequestCtx.guard :: guard(action: Actions, subject: Subjects): void
@/plugins/api :: member :: RequestCtx.can :: can(action: Actions, subject: Subjects): boolean
@/plugins/api :: member :: RequestCtx.hasFeature :: hasFeature(name: string): boolean
@/plugins/api :: member :: RequestCtx.uuid :: uuid(name: string): string
@/plugins/api :: member :: RequestCtx.valid :: valid<T>(target: 'json' | 'query' | 'param' | 'form' | 'header' | 'cookie'): T
@/plugins/api :: member :: RequestCtx.page :: page<T>( items: T[], total: number, query: PaginationQuery ): { items: T[]; pagination: PaginationMeta }
@/plugins/api :: member :: RequestCtx.defer :: defer(fn: () => Promise<unknown>): void
@/plugins/api :: member :: RequestCtx.enqueue :: enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
@/plugins/api :: member :: RequestCtx.enqueueMany :: enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
@/plugins/api :: member :: RequestCtx.nudge :: nudge(entity: string, id?: string): void
@/plugins/api :: member :: RequestCtx.storage :: storage(): StorageService
@/plugins/api :: member :: RequestCtx.durableObject :: durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>( namespace: DurableObjectNamespace<T>, key?: string ): DurableObjectStub<T>
@/plugins/api :: member :: RequestCtx.notFound :: notFound(message?: string, code?: string): never
@/plugins/api :: member :: RequestCtx.badRequest :: badRequest(message?: string, code?: string, details?: unknown): never
@/plugins/api :: member :: RequestCtx.forbidden :: forbidden(message?: string, code?: string): never
@/plugins/api :: member :: RequestCtx.unauthorized :: unauthorized(message?: string): never
@/plugins/api :: member :: RequestCtx.conflict :: conflict(message?: string, code?: string, details?: unknown): never
@/plugins/api :: member :: RequestCtx.unavailable :: unavailable(message?: string, code?: string): never
@/plugins/api :: member :: RequestCtx.detached :: detached(): DetachedCtx
@/plugins/api :: member :: RequestCtx.realtime :: readonly realtime: Realtime
@/plugins/api :: interface :: RequestVisibility :: interface RequestVisibility
@/plugins/api :: member :: RequestVisibility.resolve :: resolve( input: { visibility?: ResourceVisibility; groupIds?: readonly string[] } | undefined ): Promise<SetResourceGroupsInput>
@/plugins/api :: member :: RequestVisibility.set :: set(kind: string, resourceId: string, input: SetResourceGroupsInput): Promise<string[]>
@/plugins/api :: member :: RequestVisibility.grantsFor :: grantsFor(kind: string, resourceIds: readonly string[]): Promise<Map<string, GroupRef[]>>
@/plugins/api :: function :: requireFeature :: function requireFeature(feature: FeatureName)
@/plugins/api :: interface :: ResourceGrantRow :: interface ResourceGrantRow
@/plugins/api :: interface :: ScheduledTask :: interface ScheduledTask
@/plugins/api :: interface :: SeedCtx :: interface SeedCtx extends Pick<PluginContext, 'db'>
@/plugins/api :: member :: SeedCtx.tenantId :: tenantId: string
@/plugins/api :: member :: SeedCtx.ownerId :: ownerId: string
@/plugins/api :: member :: SeedCtx.demoId :: demoId: (key: string) => string
@/plugins/api :: member :: SeedCtx.log :: log: (line: string) => void
@/plugins/api :: interface :: ServerPlugin :: interface ServerPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api :: member :: ServerPlugin.shared :: shared: S
@/plugins/api :: member :: ServerPlugin.requires :: requires?: PluginRequires
@/plugins/api :: member :: ServerPlugin.mounts :: mounts?: readonly PluginMount[]
@/plugins/api :: member :: ServerPlugin.apiPrefixes :: apiPrefixes?: readonly string[]
@/plugins/api :: member :: ServerPlugin.jobHandlers :: jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }
@/plugins/api :: member :: ServerPlugin.agents :: agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }
@/plugins/api :: member :: ServerPlugin.prompts :: prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }
@/plugins/api :: member :: ServerPlugin.agentTools :: agentTools?: (ctx: AgentToolContext) => Tool[]
@/plugins/api :: member :: ServerPlugin.scheduledTasks :: scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
@/plugins/api :: member :: ServerPlugin.grants :: grants?: Partial<Record<EffectiveRole, RoleGrant>>
@/plugins/api :: member :: ServerPlugin.rlsExcludedTables :: rlsExcludedTables?: readonly string[]
@/plugins/api :: member :: ServerPlugin.unscopedAllowlist :: unscopedAllowlist?: Readonly<Record<string, string>>
@/plugins/api :: member :: ServerPlugin.visibilityResources :: visibilityResources?: readonly VisibilityResource[]
@/plugins/api :: member :: ServerPlugin.hooks :: hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }
@/plugins/api :: member :: ServerPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/api :: interface :: SetResourceGroupsInput :: interface SetResourceGroupsInput
@/plugins/api :: function :: sharedWithMyGroups :: function sharedWithMyGroups( scope: AccessScope, junction: string, foreignKey: string, resourceId: SQL ): SQL
@/plugins/api :: interface :: StepCtx :: interface StepCtx extends PluginContext
@/plugins/api :: member :: StepCtx.name :: name: string
@/plugins/api :: member :: StepCtx.realtime :: realtime: StepRealtime
@/plugins/api :: interface :: StepOptions :: interface StepOptions
@/plugins/api :: member :: StepOptions.retries :: retries?: { limit: number delay: WorkflowSleepDuration | number backoff?: 'constant' | 'linear' | 'exponential' }
@/plugins/api :: member :: StepOptions.timeout :: timeout?: WorkflowSleepDuration | number
@/plugins/api :: interface :: StepRealtime :: interface StepRealtime
@/plugins/api :: member :: StepRealtime.realtime :: realtime: Realtime
@/plugins/api :: member :: StepRealtime.settle :: settle(): Promise<void>
@/plugins/api :: member :: StepRealtime.nudgeEntity :: nudgeEntity(tenantId: string, entity: string, id?: string): Promise<void>
@/plugins/api :: member :: StepRealtime.send :: send(event: RealtimeEvent): Promise<void>
@/plugins/api :: member :: StepRealtime.sendToUser :: sendToUser(userId: string, event: RealtimeEvent): Promise<void>
@/plugins/api :: member :: StepRealtime.sendToUsers :: sendToUsers(userIds: string[], event: RealtimeEvent): Promise<void>
@/plugins/api :: type :: Subjects :: type Subjects = CoreSubject | PluginSubject | FeatureSubject
@/plugins/api :: type :: Tenant :: type Tenant = typeof tenants.$inferSelect
@/plugins/api :: interface :: Tool :: interface Tool<Input = unknown>
@/plugins/api :: interface :: ToolApproval :: interface ToolApproval
@/plugins/api :: function :: toolCtx :: function toolCtx(ctx: AgentToolContext): ToolCtx
@/plugins/api :: interface :: ToolCtx :: interface ToolCtx
@/plugins/api :: member :: ToolCtx.db :: db: Database
@/plugins/api :: member :: ToolCtx.config :: config: PluginConfig
@/plugins/api :: member :: ToolCtx.env :: env: PluginBindings
@/plugins/api :: member :: ToolCtx.scope :: scope: AccessScope
@/plugins/api :: member :: ToolCtx.tenantId :: tenantId: string
@/plugins/api :: member :: ToolCtx.maxDocumentChars :: maxDocumentChars?: number
@/plugins/api :: function :: toolInputSchema :: function toolInputSchema(schema: ZodType): JsonSchema
@/plugins/api :: interface :: ToolLoopCheckpoint :: interface ToolLoopCheckpoint
@/plugins/api :: interface :: ToolLoopResult :: interface ToolLoopResult
@/plugins/api :: function :: traceChatClient :: function traceChatClient( client: ChatClient, trace: TraceHandle, meta: TraceClientMeta, tracer?: Tracer ): ChatClient
@/plugins/api :: interface :: TraceHandle :: interface TraceHandle
@/plugins/api :: interface :: Tracer :: interface Tracer
@/plugins/api :: function :: tracingEnabled :: function tracingEnabled(tracer: Tracer): boolean
@/plugins/api :: function :: transaction :: async function transaction<T>( db: PluginContext['db'], fn: (tx: PluginContext['db']) => Promise<T> ): Promise<T>
@/plugins/api :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api :: member :: UiPlugin.shared :: shared: S
@/plugins/api :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/api :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/api :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/api :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/api :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/api :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/plugins/api :: type :: User :: type User = typeof users.$inferSelect
@/plugins/api :: function :: validate :: function validate<T extends ZodSchema, Target extends keyof ValidationTargets>( target: Target, schema: T )
@/plugins/api :: interface :: VisibilityResource :: interface VisibilityResource
@/plugins/api :: function :: withAgentTrace :: async function withAgentTrace<T>( name: string, ctx: AgentTraceContext, fn: (trace: TraceHandle) => Promise<T> ): Promise<T>
@/plugins/api :: function :: workflowCtx :: function workflowCtx( step: WorkflowStep, env: PluginBindings, config: AppConfig, logger: Logger ): WorkflowCtx
@/plugins/api :: interface :: WorkflowCtx :: interface WorkflowCtx
@/plugins/api :: member :: WorkflowCtx.config :: config: AppConfig
@/plugins/api :: member :: WorkflowCtx.env :: env: PluginBindings
@/plugins/api :: member :: WorkflowCtx.logger :: logger: Logger
@/plugins/api :: member :: WorkflowCtx.step :: step<T extends Rpc.Serializable<T>>( name: string, options: StepOptions, fn: (ctx: StepCtx) => Promise<T> ): Promise<T>
@/plugins/api :: member :: WorkflowCtx.step :: step<T extends Rpc.Serializable<T>>(name: string, fn: (ctx: StepCtx) => Promise<T>): Promise<T>
@/plugins/api :: member :: WorkflowCtx.waitForEvent :: waitForEvent( name: string, options: { type: string; timeout?: WorkflowSleepDuration | number } ): Promise<unknown>
@/plugins/api/peers :: function :: allTables :: function allTables(): AllTables
@/plugins/api/peers :: type :: AllTables :: type AllTables = typeof schema
@/plugins/api/peers :: function :: extensions :: function extensions(key: string): readonly unknown[]
@/plugins/api/peers :: function :: extensionSources :: function extensionSources(key: string): readonly string[]
@/plugins/api/ui-wiring :: type :: AnyUiPlugin :: type AnyUiPlugin = UiPlugin<SharedPlugin>
@/plugins/api/ui-wiring :: const :: featureGuard :: const featureGuard: (feature: NavGuard, guard: NavGuard) => NavGuard
@/plugins/api/ui-wiring :: const :: isGuardList :: const isGuardList: (guard: NavGuard) => guard is readonly NavGuard[]
@/plugins/api/ui-wiring :: type :: NavConfig :: type NavConfig = (NavItem | NavGroup)[]
@/plugins/api/ui-wiring :: interface :: NavGroup :: interface NavGroup
@/plugins/api/ui-wiring :: type :: NavGuard :: type NavGuard = | 'admin' | 'globalAdmin' | { action: string; subject: string } | { feature: string } | readonly NavGuard[]
@/plugins/api/ui-wiring :: interface :: NavItem :: interface NavItem
@/plugins/api/ui-wiring :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/api/ui-wiring :: member :: PluginNavGroup.label :: label?: string
@/plugins/api/ui-wiring :: member :: PluginNavGroup.before :: before?: string
@/plugins/api/ui-wiring :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/api/ui-wiring :: interface :: PluginRoute :: interface PluginRoute
@/plugins/api/ui-wiring :: member :: PluginRoute.path :: path: string
@/plugins/api/ui-wiring :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/api/ui-wiring :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/api/ui-wiring :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/api/ui-wiring :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public'
@/plugins/api/ui-wiring :: interface :: QuickLink :: interface QuickLink
@/plugins/api/ui-wiring :: interface :: TabConfig :: interface TabConfig
@/plugins/api/ui-wiring :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api/ui-wiring :: member :: UiPlugin.shared :: shared: S
@/plugins/api/ui-wiring :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/api/ui-wiring :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/api/ui-wiring :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/api/ui-wiring :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/api/ui-wiring :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/api/ui-wiring :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/plugins/api/ui-wiring :: function :: useNavGuard :: function useNavGuard(): (guard: NavGuard | undefined) => boolean
@/plugins/api/ui :: function :: AccessBadge :: function AccessBadge({ visibility, groups, className = '', }: { visibility: ResourceVisibility groups: GroupRef[] className?: string })
@/plugins/api/ui :: function :: AccessPicker :: function AccessPicker({ visibility, groupIds, available, onChange, tenantName, disabled = false, idPrefix = 'access', }: AccessPickerProps)
@/plugins/api/ui :: interface :: AccessPickerProps :: interface AccessPickerProps
@/plugins/api/ui :: function :: AlertModal :: function AlertModal({ isOpen, title, message, type = 'info', onClose }: AlertModalProps)
@/plugins/api/ui :: const :: api :: const api: { get<T>(url: string, options?: ApiRequestOptions<T>): Promise<T>; post<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; put<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; patch<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>):… (truncated)
@/plugins/api/ui :: class :: ApiError :: class ApiError extends Error
@/plugins/api/ui :: interface :: ApiRequestOptions :: interface ApiRequestOptions<T = unknown> extends Omit<RequestInit, 'body'>
@/plugins/api/ui :: interface :: Breadcrumb :: interface Breadcrumb
@/plugins/api/ui :: function :: ConfirmModal :: function ConfirmModal({ isOpen, title, message, confirmText = 'Confirm', cancelText = 'Cancel', confirmButtonClass = 'btn-primary', isLoading = false, onCancel, onConfirm, }: ConfirmModalProps)
@/plugins/api/ui :: function :: DocumentCard :: function DocumentCard({ card, to, dense = false, footer }: DocumentCardProps)
@/plugins/api/ui :: interface :: DocumentCardProps :: interface DocumentCardProps
@/plugins/api/ui :: function :: DocumentLink :: function DocumentLink({ to, title, meta, status, id }: DocumentLinkProps)
@/plugins/api/ui :: function :: documentLinkProps :: function documentLinkProps(card: DocumentCardData): DocumentLinkProps
@/plugins/api/ui :: interface :: DocumentLinkProps :: interface DocumentLinkProps
@/plugins/api/ui :: function :: EmptyState :: function EmptyState({ icon: Icon, message, description, action, className = '', size = 'md', }: EmptyStateProps)
@/plugins/api/ui :: function :: EmptyStateCard :: function EmptyStateCard(props: EmptyStateProps)
@/plugins/api/ui :: function :: FieldError :: function FieldError({ message, id }: { message?: string | null; id?: string })
@/plugins/api/ui :: function :: fieldErrorFor :: function fieldErrorFor( issues: readonly { path: readonly PropertyKey[]; message: string }[] | undefined, field: string ): string | undefined
@/plugins/api/ui :: function :: formatBytes :: function formatBytes(bytes: number | null | undefined, fallback = '—'): string
@/plugins/api/ui :: function :: formatDate :: function formatDate(value: Date | null | undefined, fallback = '—'): string
@/plugins/api/ui :: function :: formatDateTime :: function formatDateTime(value: Date | null | undefined, fallback = '—'): string
@/plugins/api/ui :: function :: formatDuration :: function formatDuration(ms: number): string
@/plugins/api/ui :: function :: initials :: function initials(name: string | null | undefined, email?: string): string
@/plugins/api/ui :: function :: LoadingIndicator :: function LoadingIndicator({ size = 'md', centered = false, fullPage = false, className = '', }: LoadingIndicatorProps)
@/plugins/api/ui :: function :: LogoMark :: function LogoMark({ className = 'w-7 h-7' }: { className?: string })
@/plugins/api/ui :: function :: Modal :: function Modal({ open, onClose, title, children, actions, closeButton = true, className = '', }: ModalProps)
@/plugins/api/ui :: interface :: ModalProps :: interface ModalProps
@/plugins/api/ui :: type :: NavGuard :: type NavGuard = | 'admin' | 'globalAdmin' | { action: string; subject: string } | { feature: string } | readonly NavGuard[]
@/plugins/api/ui :: function :: notifyUnauthorized :: function notifyUnauthorized(error: ApiError): void
@/plugins/api/ui :: function :: PageHeader :: function PageHeader({ title, description, breadcrumbs, badge, actions, className = '', }: PageHeaderProps)
@/plugins/api/ui :: function :: PaginationControls :: function PaginationControls({ pagination, onPageChange, isLoading = false, className = '', }: PaginationControlsProps)
@/plugins/api/ui :: function :: SearchInput :: function SearchInput({ value, onChange, placeholder = 'Search…', debounceMs = 300, className = '', size = 'md', 'aria-label': ariaLabel = 'Search', }: SearchInputProps)
@/plugins/api/ui :: function :: SectionPanel :: function SectionPanel({ title, description, actions, children, className = '', flush = false, }: SectionPanelProps)
@/plugins/api/ui :: function :: SectionPanelSkeleton :: function SectionPanelSkeleton({ rows = 4, className = '', }: { rows?: number className?: string })
@/plugins/api/ui :: function :: SettingInput :: function SettingInput({ id, label, description, value, onChange, placeholder, type = 'text', disabled, error, }: SettingInputProps)
@/plugins/api/ui :: function :: SettingRow :: function SettingRow({ label, description, children, htmlFor, className = '', }: SettingRowProps)
@/plugins/api/ui :: function :: SettingToggle :: function SettingToggle({ id, label, description, checked, onChange, disabled, }: SettingToggleProps)
@/plugins/api/ui :: function :: setUnauthorizedHandler :: function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void
@/plugins/api/ui :: function :: showToast :: function showToast(message: string, type: ToastType, duration?: number): void
@/plugins/api/ui :: function :: SideNav :: default function SideNav({ items = navigationConfig, footer }: SideNavProps)
@/plugins/api/ui :: function :: SkeletonRows :: function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string })
@/plugins/api/ui :: interface :: TabConfig :: interface TabConfig
@/plugins/api/ui :: function :: timeAgo :: function timeAgo(value: Date | null | undefined, fallback = 'never'): string
@/plugins/api/ui :: interface :: Toast :: interface Toast
@/plugins/api/ui :: function :: ToastContainer :: function ToastContainer()
@/plugins/api/ui :: type :: ToastType :: type ToastType = 'success' | 'error' | 'warning' | 'info'
@/plugins/api/ui :: function :: URLTabs :: function URLTabs({ tabs, defaultTab, param = 'tab', className = '', actions, }: URLTabsProps)
@/plugins/api/ui :: function :: useAuth :: function useAuth(): AuthContextValue
@/plugins/api/ui :: function :: useFeature :: function useFeature(name: FeatureName): boolean
@/plugins/api/ui :: function :: useGroups :: function useGroups(typeId?: string, enabled = true)
@/plugins/api/ui :: function :: useGroupTypes :: function useGroupTypes(enabled = true)
@/plugins/api/ui :: function :: useMyGroups :: function useMyGroups()
@/plugins/api/ui :: function :: usePermissions :: function usePermissions()
@/plugins/api/ui :: function :: useTenancyMode :: function useTenancyMode(): TenancyMode
@/plugins/api/ui :: const :: useToastStore :: const useToastStore: UseBoundStore<StoreApi<ToastStore>>
@/plugins/api/ui :: function :: VisibilityModal :: function VisibilityModal({ open, onClose, name, visibility, groups, available, tenantName, isSaving = false, onSave, }: VisibilityModalProps)
@/plugins/api/ui :: interface :: VisibilityModalProps :: interface VisibilityModalProps
@/plugins/types :: type :: AnyServerPlugin :: type AnyServerPlugin = ServerPlugin<SharedPlugin>
@/plugins/types :: type :: AnyUiPlugin :: type AnyUiPlugin = UiPlugin<SharedPlugin>
@/plugins/types :: type :: PluginMount :: type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]
@/plugins/types :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/types :: member :: PluginNavGroup.label :: label?: string
@/plugins/types :: member :: PluginNavGroup.before :: before?: string
@/plugins/types :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/types :: interface :: PluginRequires :: interface PluginRequires
@/plugins/types :: interface :: PluginRoute :: interface PluginRoute
@/plugins/types :: member :: PluginRoute.path :: path: string
@/plugins/types :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/types :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/types :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/types :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public'
@/plugins/types :: interface :: PluginSeedContext :: interface PluginSeedContext
@/plugins/types :: interface :: ServerPlugin :: interface ServerPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/types :: member :: ServerPlugin.shared :: shared: S
@/plugins/types :: member :: ServerPlugin.requires :: requires?: PluginRequires
@/plugins/types :: member :: ServerPlugin.mounts :: mounts?: readonly PluginMount[]
@/plugins/types :: member :: ServerPlugin.apiPrefixes :: apiPrefixes?: readonly string[]
@/plugins/types :: member :: ServerPlugin.jobHandlers :: jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }
@/plugins/types :: member :: ServerPlugin.agents :: agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }
@/plugins/types :: member :: ServerPlugin.prompts :: prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }
@/plugins/types :: member :: ServerPlugin.agentTools :: agentTools?: (ctx: AgentToolContext) => Tool[]
@/plugins/types :: member :: ServerPlugin.scheduledTasks :: scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
@/plugins/types :: member :: ServerPlugin.grants :: grants?: Partial<Record<EffectiveRole, RoleGrant>>
@/plugins/types :: member :: ServerPlugin.rlsExcludedTables :: rlsExcludedTables?: readonly string[]
@/plugins/types :: member :: ServerPlugin.unscopedAllowlist :: unscopedAllowlist?: Readonly<Record<string, string>>
@/plugins/types :: member :: ServerPlugin.visibilityResources :: visibilityResources?: readonly VisibilityResource[]
@/plugins/types :: member :: ServerPlugin.hooks :: hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }
@/plugins/types :: member :: ServerPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/types :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/types :: member :: UiPlugin.shared :: shared: S
@/plugins/types :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/types :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/types :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/types :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/types :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/types :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/db/schema/kit :: const :: activityEvents :: const activityEvents: table "activity_events" { id, tenantId, userId, type, subjectType, subjectId, metadata, createdAt }
@/db/schema/kit :: const :: groupMembers :: const groupMembers: table "group_members" { tenantId, groupId, userId, createdAt }
@/db/schema/kit :: const :: groups :: const groups: table "groups" { createdAt, updatedAt, id, tenantId, groupTypeId, name, description }
@/db/schema/kit :: const :: groupTypes :: const groupTypes: table "group_types" { createdAt, updatedAt, id, tenantId, name, description }
@/db/schema/kit :: function :: membershipIsolation :: function membershipIsolation()
@/db/schema/kit :: const :: RESOURCE_VISIBILITY_VALUES :: const RESOURCE_VISIBILITY_VALUES: readonly ["tenant", "groups"]
@/db/schema/kit :: function :: tenantIsolation :: function tenantIsolation(table: string, column = sql`tenant_id`)
@/db/schema/kit :: function :: tenantRef :: function tenantRef(tenants: { id: AnyPgColumn })
@/db/schema/kit :: const :: tenants :: const tenants: table "tenants" { createdAt, updatedAt, id, name, slug, status, seedDataCreated, lastAccessedAt }
@/db/schema/kit :: const :: tenantUsers :: const tenantUsers: table "tenant_users" { tenantId, userId, role, joinedAt, invitedByUserId }
@/db/schema/kit :: function :: timestamps :: function timestamps()
@/db/schema/kit :: const :: users :: const users: table "users" { createdAt, updatedAt, id, email, name, avatarUrl, isGlobalAdmin, emailVerifiedAt, lastLoginAt, blockedAt }
@rocketflare/shared/plugins/api :: type :: Actions :: type Actions = (typeof ACTIONS)[number]
@rocketflare/shared/plugins/api :: type :: AgentKeyOf :: type AgentKeyOf = NonNullable<DeclaredBy<S, 'agentKeys'>>[number]
@rocketflare/shared/plugins/api :: type :: ApiErrorBody :: type ApiErrorBody = z.infer<typeof apiErrorSchema>
@rocketflare/shared/plugins/api :: const :: apiErrorSchema :: const apiErrorSchema: z.ZodObject<{ error: z.ZodString; statusCode: z.ZodNumber; code: z.ZodOptional<z.ZodString>; details: z.ZodOptional<z.ZodUnknown>; }, "strip", z.ZodTypeAny, { error: string; statusCode: number; code?: string | undefined; details?: unknown; }, { error: string; statusCode: number; code?: string | unde… (truncated)
@rocketflare/shared/plugins/api :: type :: DeclaredBy :: type DeclaredBy = Extract<P, Record<K, unknown>> extends infer Declaring ? Declaring extends Record<K, unknown> ? Declaring[K] : never : never
@rocketflare/shared/plugins/api :: const :: ERROR_CODES :: const ERROR_CODES: { readonly validationFailed: "validation_failed"; readonly unauthorized: "unauthorized"; readonly sessionExpired: "session_expired"; readonly forbidden: "forbidden"; readonly notFound: "not_found"; readonly conflict: "conflict"; readonly rateLimited: "rate_limited"; readonly pendingApproval: "pendin… (truncated)
@rocketflare/shared/plugins/api :: type :: ErrorCode :: type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
@rocketflare/shared/plugins/api :: interface :: FeatureDefinition :: interface FeatureDefinition
@rocketflare/shared/plugins/api :: type :: FeatureFlagState :: type FeatureFlagState = z.infer<typeof featureFlagStateSchema>
@rocketflare/shared/plugins/api :: type :: FeatureKeyOf :: type FeatureKeyOf = Extract< keyof NonNullable<DeclaredBy<S, 'features'>>, string >
@rocketflare/shared/plugins/api :: type :: FeatureRolloutUnit :: type FeatureRolloutUnit = z.infer<typeof featureRolloutUnitSchema>
@rocketflare/shared/plugins/api :: type :: GroupRef :: type GroupRef = z.infer<typeof groupRefSchema>
@rocketflare/shared/plugins/api :: function :: isPluginId :: function isPluginId(value: string): boolean
@rocketflare/shared/plugins/api :: type :: JobInput :: type JobInput = z.infer<typeof jobInputSchema>
@rocketflare/shared/plugins/api :: type :: JobOf :: type JobOf = Extract<JobEnvelope, { type: T }>
@rocketflare/shared/plugins/api :: type :: JobType :: type JobType = JobEnvelope['type']
@rocketflare/shared/plugins/api :: type :: JobTypeOf :: type JobTypeOf = TypeOf< NonNullable<DeclaredBy<S, 'jobs'>>[number] >['type']
@rocketflare/shared/plugins/api :: type :: JobVariant :: type JobVariant = ZodDiscriminatedUnionOption<'type'>
@rocketflare/shared/plugins/api :: type :: MembershipRole :: type MembershipRole = z.infer<typeof membershipRoleSchema>
@rocketflare/shared/plugins/api :: function :: paginatedResponse :: function paginatedResponse<T extends z.ZodTypeAny>(item: T)
@rocketflare/shared/plugins/api :: function :: paginationMeta :: function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta
@rocketflare/shared/plugins/api :: type :: PaginationMeta :: type PaginationMeta = z.infer<typeof paginationMetaSchema>
@rocketflare/shared/plugins/api :: const :: paginationMetaSchema :: const paginationMetaSchema: z.ZodObject<{ page: z.ZodNumber; pageSize: z.ZodNumber; total: z.ZodNumber; totalPages: z.ZodNumber; }, "strip", z.ZodTypeAny, { page: number; pageSize: number; total: number; totalPages: number; }, { page: number; pageSize: number; total: number; totalPages: number; }>
@rocketflare/shared/plugins/api :: type :: PaginationQuery :: type PaginationQuery = z.infer<typeof paginationQuerySchema>
@rocketflare/shared/plugins/api :: const :: paginationQuerySchema :: const paginationQuerySchema: z.ZodObject<{ page: z.ZodDefault<z.ZodNumber>; pageSize: z.ZodDefault<z.ZodNumber>; }, "strip", z.ZodTypeAny, { page: number; pageSize: number; }, { page?: number | undefined; pageSize?: number | undefined; }>
@rocketflare/shared/plugins/api :: const :: PLUGIN_ID_RE :: const PLUGIN_ID_RE: RegExp
@rocketflare/shared/plugins/api :: function :: pluginNamespace :: function pluginNamespace(id: string): string
@rocketflare/shared/plugins/api :: type :: PromptKeyOf :: type PromptKeyOf = NonNullable<DeclaredBy<S, 'promptKeys'>>[number]
@rocketflare/shared/plugins/api :: type :: RealtimeEvent :: type RealtimeEvent = z.infer<typeof realtimeEventSchema>
@rocketflare/shared/plugins/api :: type :: RealtimeEventType :: type RealtimeEventType = z.infer<typeof realtimeEventTypeSchema>
@rocketflare/shared/plugins/api :: type :: ResourceVisibility :: type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>
@rocketflare/shared/plugins/api :: interface :: SharedPlugin :: interface SharedPlugin
@rocketflare/shared/plugins/api :: member :: SharedPlugin.id :: readonly id: string
@rocketflare/shared/plugins/api :: member :: SharedPlugin.label :: readonly label: string
@rocketflare/shared/plugins/api :: member :: SharedPlugin.version :: readonly version?: string
@rocketflare/shared/plugins/api :: member :: SharedPlugin.agentKeys :: readonly agentKeys?: readonly string[]
@rocketflare/shared/plugins/api :: member :: SharedPlugin.promptKeys :: readonly promptKeys?: readonly string[]
@rocketflare/shared/plugins/api :: member :: SharedPlugin.jobs :: readonly jobs?: readonly JobVariant[]
@rocketflare/shared/plugins/api :: member :: SharedPlugin.subjects :: readonly subjects?: readonly string[]
@rocketflare/shared/plugins/api :: member :: SharedPlugin.features :: readonly features?: Readonly<Record<string, FeatureDefinition>>
@rocketflare/shared/plugins/api :: member :: SharedPlugin.config :: readonly config?: ZodRawShape
@rocketflare/shared/plugins/api :: member :: SharedPlugin.realtimeRoots :: readonly realtimeRoots?: readonly string[]
@rocketflare/shared/plugins/api :: type :: SubjectOf :: type SubjectOf = NonNullable<DeclaredBy<S, 'subjects'>>[number]
@rocketflare/shared/plugins/api :: type :: Subjects :: type Subjects = CoreSubject | PluginSubject | FeatureSubject
@rocketflare/shared/plugins/contract :: const :: PLUGIN_API :: const PLUGIN_API: { readonly current: 1; readonly minSupported: 1; }
@rocketflare/shared/plugins/contract :: interface :: PluginApiVersions :: interface PluginApiVersions
'../api' (apps/cli/src/plugins/api.ts) :: type :: ActionWrapper :: type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>
'../api' (apps/cli/src/plugins/api.ts) :: type :: AnyCliPlugin :: type AnyCliPlugin = CliPlugin<SharedPlugin>
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ApiClient :: interface ApiClient
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ApiResponse :: interface ApiResponse<T>
'../api' (apps/cli/src/plugins/api.ts) :: class :: CliApiError :: class CliApiError extends CliError
'../api' (apps/cli/src/plugins/api.ts) :: class :: CliError :: class CliError extends Error
'../api' (apps/cli/src/plugins/api.ts) :: interface :: CliPlugin :: interface CliPlugin<S extends SharedPlugin = SharedPlugin>
'../api' (apps/cli/src/plugins/api.ts) :: member :: CliPlugin.shared :: shared: S
'../api' (apps/cli/src/plugins/api.ts) :: member :: CliPlugin.register :: register(program: Command, action: ActionWrapper): void
'../api' (apps/cli/src/plugins/api.ts) :: interface :: Column :: interface Column<Row>
'../api' (apps/cli/src/plugins/api.ts) :: interface :: CommandContext :: interface CommandContext
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ContextOptions :: interface ContextOptions
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_ERROR :: const EXIT_ERROR: 1
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_FORBIDDEN :: const EXIT_FORBIDDEN: 3
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_NOT_LOGGED_IN :: const EXIT_NOT_LOGGED_IN: 2
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_OK :: const EXIT_OK: 0
'../api' (apps/cli/src/plugins/api.ts) :: function :: exitCodeForStatus :: function exitCodeForStatus(status: number): number
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatCell :: function formatCell(value: unknown): string
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatDate :: function formatDate(value: Date | string | null | undefined): string
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatJson :: function formatJson(value: unknown): string
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatPagination :: function formatPagination(meta: { page: number totalPages: number total: number pageSize: number }): string
'../api' (apps/cli/src/plugins/api.ts) :: class :: NotLoggedInError :: class NotLoggedInError extends CliError
'../api' (apps/cli/src/plugins/api.ts) :: type :: OpenLike :: type OpenLike = (url: string) => Promise<unknown>
'../api' (apps/cli/src/plugins/api.ts) :: interface :: Output :: interface Output
'../api' (apps/cli/src/plugins/api.ts) :: function :: publicClient :: function publicClient(ctx: CommandContext): ApiClient
'../api' (apps/cli/src/plugins/api.ts) :: type :: QueryValue :: type QueryValue = string | number | boolean | undefined | null
'../api' (apps/cli/src/plugins/api.ts) :: function :: renderTable :: function renderTable<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string
'../api' (apps/cli/src/plugins/api.ts) :: interface :: RequestOptions :: interface RequestOptions<T>
'../api' (apps/cli/src/plugins/api.ts) :: function :: requireClient :: function requireClient(ctx: CommandContext): ApiClient
'./types' (apps/cli/src/plugins/types.ts) :: type :: ActionWrapper :: type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>
'./types' (apps/cli/src/plugins/types.ts) :: type :: AnyCliPlugin :: type AnyCliPlugin = CliPlugin<SharedPlugin>
'./types' (apps/cli/src/plugins/types.ts) :: interface :: CliPlugin :: interface CliPlugin<S extends SharedPlugin = SharedPlugin>
'./types' (apps/cli/src/plugins/types.ts) :: member :: CliPlugin.shared :: shared: S
'./types' (apps/cli/src/plugins/types.ts) :: member :: CliPlugin.register :: register(program: Command, action: ActionWrapper): void
@testkit/integration :: function :: bearerHeader :: function bearerHeader(key: string): Record<string, string>
@testkit/integration :: function :: cleanDatabase :: async function cleanDatabase(db: Database): Promise<void>
@testkit/integration :: function :: createExecutionContext :: function createExecutionContext(): TestExecutionContext
@testkit/integration :: function :: createTestApiKey :: async function createTestApiKey( db: Database, tenantId: string, userId: string, overrides: Partial<Omit<NewApiKey, 'keyHash' | 'keyPrefix'>> = {} )
@testkit/integration :: function :: createTestEnv :: function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv
@testkit/integration :: function :: createTestGlobalAdmin :: function createTestGlobalAdmin(db: Database, overrides: Partial<NewUser> = {})
@testkit/integration :: function :: createTestQueryClient :: function createTestQueryClient()
@testkit/integration :: function :: createTestSession :: async function createTestSession( db: Database, userId: string, tenantId?: string | null, options: { expiresInDays?: number; ip?: string; userAgent?: string } = {} ): Promise<string>
@testkit/integration :: function :: createTestTenant :: async function createTestTenant(db: Database, overrides: Partial<NewTenant> = {})
@testkit/integration :: function :: createTestTenantWithUser :: async function createTestTenantWithUser( db: Database, role: MembershipRole = 'owner', userOverrides: Partial<NewUser> = {}, tenantOverrides: Partial<NewTenant> = {} )
@testkit/integration :: function :: createTestUser :: async function createTestUser(db: Database, overrides: Partial<NewUser> = {})
@testkit/integration :: function :: dispatchScheduled :: async function dispatchScheduled( cron: string, env: AppBindings, ctx: Pick<ExecutionContext, 'waitUntil'>, registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS ): Promise<TaskReport[]>
@testkit/integration :: function :: errorResponse :: function errorResponse(status: number, error = 'Error', code?: string)
@testkit/integration :: const :: IDS :: const IDS: { user: string; otherUser: string; tenant: string; otherTenant: string; }
@testkit/integration :: function :: json :: async function json<T = unknown>(res: Response): Promise<T>
@testkit/integration :: function :: jsonResponse :: function jsonResponse(body: unknown, status = 200)
@testkit/integration :: function :: linkUserToTenant :: async function linkUserToTenant( db: Database, userId: string, tenantId: string, role: MembershipRole = 'member', invitedByUserId: string | null = null )
@testkit/integration :: function :: makeSession :: function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse
@testkit/integration :: function :: makeTenant :: function makeTenant(overrides: Partial<TenantSummary> = {}): TenantSummary
@testkit/integration :: function :: makeUser :: function makeUser(overrides: Partial<User> = {}): User
@testkit/integration :: const :: notFoundResponse :: const notFoundResponse: () => Response
@testkit/integration :: function :: paged :: function paged<T>(items: T[], pageSize = 25)
@testkit/integration :: interface :: RecordedMessage :: interface RecordedMessage<T = unknown>
@testkit/integration :: function :: renderWithProviders :: function renderWithProviders( ui: ReactElement, { route = '/', queryClient = createTestQueryClient(), session, ...options }: ProviderOptions = {} )
@testkit/integration :: function :: request :: async function request( path: string, init: RequestInit = {}, options: RequestOptions = {} ): Promise<Response>
@testkit/integration :: function :: requestBody :: function requestBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>, key: string)
@testkit/integration :: interface :: RequestOptions :: interface RequestOptions
@testkit/integration :: type :: RouteTable :: type RouteTable = Record< string, Response | unknown | ((init: RequestInit | undefined, url: URL) => Response | unknown) >
@testkit/integration :: function :: rulesFor :: function rulesFor( role: MembershipRole | null, isGlobalAdmin = false, features: string[] = [] )
@testkit/integration :: const :: SCHEDULED_TASKS :: const SCHEDULED_TASKS: Record<string, ScheduledTask[]>
@testkit/integration :: interface :: ScheduledTask :: interface ScheduledTask
@testkit/integration :: const :: SESSION_COOKIE_NAME :: const SESSION_COOKIE_NAME: "__Host-session"
@testkit/integration :: function :: sessionCookieHeader :: function sessionCookieHeader(token: string): Record<string, string>
@testkit/integration :: function :: setupTestDatabase :: function setupTestDatabase(): Database
@testkit/integration :: function :: stubFetch :: function stubFetch(routes: RouteTable = {})
@testkit/integration :: function :: stubHealthFetch :: function stubHealthFetch(info: Record<string, unknown> = {})
@testkit/integration :: function :: stubs :: function stubs(env: TestEnv)
@testkit/integration :: function :: stubSessionFetch :: function stubSessionFetch(session: SessionResponse | null)
@testkit/integration :: interface :: TaskReport :: interface TaskReport
@testkit/integration :: function :: testDatabaseUrl :: function testDatabaseUrl(): string
@testkit/integration :: type :: TestEnv :: type TestEnv = AppBindings & { DATABASE_URL: string [secret: string]: unknown }
@testkit/integration :: interface :: TestSeed :: interface TestSeed
@testkit/integration :: const :: unauthorizedResponse :: const unauthorizedResponse: () => Response
@testkit/integration :: function :: uniqueId :: function uniqueId(): string
@testkit/integration :: function :: waitOnExecutionContext :: async function waitOnExecutionContext(ctx: TestExecutionContext): Promise<void>
@testkit/unit :: interface :: CronCtxOptions :: interface CronCtxOptions extends BaseOptions
@testkit/unit :: type :: FakeRequestCtx :: type FakeRequestCtx = RequestCtx & { readonly deferred: ReadonlyArray<() => Promise<unknown>> settle(): Promise<void> }
@testkit/unit :: type :: FakeWorkflowCtx :: type FakeWorkflowCtx = WorkflowCtx & { readonly recorded: ReturnType<typeof createFakeWorkflowStep> }
@testkit/unit :: function :: makeCronCtx :: function makeCronCtx(options: CronCtxOptions): CronCtx
@testkit/unit :: function :: makeJobCtx :: function makeJobCtx(options: BaseOptions): JobCtx
@testkit/unit :: function :: makeRequestCtx :: function makeRequestCtx(options: RequestCtxOptions): FakeRequestCtx
@testkit/unit :: function :: makeToolCtx :: function makeToolCtx(options: ToolCtxOptions): ToolCtx
@testkit/unit :: function :: makeWorkflowCtx :: function makeWorkflowCtx(options: WorkflowCtxOptions): FakeWorkflowCtx
@testkit/unit :: interface :: RequestCtxOptions :: interface RequestCtxOptions extends BaseOptions
@testkit/unit :: interface :: ToolCtxOptions :: interface ToolCtxOptions extends BaseOptions
@testkit/unit :: interface :: WorkflowCtxOptions :: interface WorkflowCtxOptions extends BaseOptions
```
