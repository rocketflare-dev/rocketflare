# The plugin API

**Generated. Do not edit.** `node scripts/plugin-api-doc.mjs` writes this file from the source of
the declared entries, and the kit's CI (`.github/workflows/kit.yml`) regenerates it and diffs
it: a generated artefact that is committed and diff-checked cannot drift from its source. **A diff
failure means this file is stale. Run the script and commit what it writes.**

One other failure comes out of the same script and means something different:

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

## The entries

One section per declared entry. A nested list under a type is its own members: those are part
of the contract too, and removing one is a break the ledger catches.

### `@/plugins/api`

The server surface: the context family, and the types a plugin must be able to name.

> The plugin API — the ONE module a plugin's server half imports from the host.

- `type AbilityCheck = (action: Actions, subject: Subjects) => boolean`
  The two-argument ability check, as a plugin's own helper takes it.
- `interface AccessScope`
- `type Actions = (typeof ACTIONS)[number]`
- `interface ActivityInput`
- `function affected(result: unknown): number`
  The number of rows an `insert` / `update` / `delete` without `.returning()` touched: postgres.js reports `.count`, Neon `.rowCount`.
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
    The built-in knowledge tools plus every installed plugin's, bound to this run's scope.
  - `storage(): StorageService`
    R2 (the `FILES` bucket), or a 503 `storage_not_configured` — the same service every other context's `storage()` returns. Read and write under `tenants/<ctx.tenantId>/<plugin…
  - `emit: TenantEmit`
    Emit a declared plugin event (D42) in the run's organisation. A side effect: wrap it in `once`, and derive its `idempotencyKey` from `runId`, so a retried step emits once.
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
  - `decide: AgentDecide`
    Typed questions answered with probabilities: `decide(key, { state, questions })`, `decide.sift(key, …)`, `decide.pick(key, …)`. The tenant's decisions engine answers — TypeSafe's…
  - `interrupt(ask: AgentInterruptAsk): Promise<AgentInterruptAnswer>`
    Ask the person a question and park the run until they answer — `approval`, `choice`, `input` or `form`. The SECOND time this line runs (the run resumed after the answer,…
  - `readonly chatModel: { readonly provider: AiProvider; readonly model: string }`
    The provider and model this run resolved to (per-agent `agent_models` assignment applied) — what `recordUsage` needs to ledger a `structured` call's `onUsage`. Read-only: the…
- `interface AgentDecide`
  `ctx.decide` — callable, with the two shapes as properties.
- `interface AgentEventBinding<E extends EventName = EventName, Input = unknown>`
  An OPT-IN: the agent may be started by `event` when a subject NAMES it — a form block an editor pointed at it — never by the event alone. Listed by `GET…
- `interface AgentEventTrigger<E extends EventName = EventName, Input = unknown>`
  An AUTOMATIC agent start: every `event` (that `where` accepts) starts the agent with `input(payload)`, through `enqueueRun` — input validated against the agent's `inputSchema`,…
- `interface AgentInterruptAnswer`
  The answer. `status` is AG-UI's own `ResumeEntry` vocabulary and there is deliberately no `approved` boolean: two ways to say no is how a UI and a server end up disagreeing.
- `interface AgentInterruptAsk`
  What an agent asks a person through {@link AgentContext.interrupt}.
- `interface AgentSummary`
  One registered agent, as a catalogue lists it: no schemas, nothing tenant-specific.
- `interface AgentTraceContext extends Omit<TraceParams, 'name'>`
- `class AiNotConfiguredError extends ServiceUnavailableError`
  503 `ai_not_configured`: nothing resolves for the tenant (no config row, no platform key).
- `type AnyServerPlugin = ServerPlugin<SharedPlugin>`
  The element type of the barrels — a plugin whose shared half is not narrowed.
- `function anyTermTsquery(query: string): string \| null`
  The lexical half's query: every distinct word of the input, OR-ed (`a | b | c`), for `to_tsquery(SEARCH_TEXT_CONFIG, …)` to stem and stopword. ANY rather than ALL terms on purpose…
- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `type AppRouter = Hono<AppEnv>`
- `interface BackgroundMethods`
  What every background context can do, tenant supplied per call.
  - `enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>`
    Enqueue follow-on work. A missing `JOBS_QUEUE` throws rather than running inline.
  - `enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>`
  - `nudge(tenantId: string, entity: string, id?: string): Promise<void>`
    Tell one organisation's open tabs that a family of rows moved. **Awaited**, unlike a route's nudge: there is no `waitUntil` here to hang it on.
  - `durableObject<T extends Rpc.DurableObjectBranded \| undefined = undefined>( namespace: DurableObjectNamespace<T>, tenantId: string, key?: string ): DurableObjectStub<T>`
    A per-tenant Durable Object stub, with the tenant prefix built here rather than by the caller.
  - `features(tenantId: string): Promise<readonly string[]>`
    The feature keys one organisation has — what `auth.features` is on a request, resolved here for a tenant named per call. A cron that fans out across every organisation reads this…
  - `storage(): StorageService`
    R2 (the `FILES` bucket), or a 503 `storage_not_configured` — loud, because a silently absent bucket loses bytes. The same service `RequestCtx.storage()` returns. Write under…
  - `startAgentRun(input: StartAgentRunInput): Promise<StartedAgentRun>`
    Start an agent run for one organisation and return its id — `POST /api/agents/runs` from a job, through the same `enqueueRun`: input validation (400), the exclusive slot, the…
  - `emit: Emit`
    Emit a declared plugin event (D42) for one organisation: validated against the declaration (400), recorded in `plugin_events`, one delivery queued per subscriber; never runs a…
- `type BindableAgent = z.infer<typeof bindableAgentSchema>`
- `function candidatePoolSize(limit: number): number`
  "Retrieve wide, fuse narrow": how many candidates each signal contributes before fusion.
- `async function chatModelAvailable( ctx: Pick<PluginContext, 'db' \| 'config' \| 'env'>, tenantId: string, promptKey: string ): Promise<boolean>`
  Would a chat model resolve for this prompt key and tenant? Answers the same question `resolveChat` will, without building a client, so a plugin's route or UI can say "no model" up…
- `function createRouter(): Hono<AppEnv>`
- `function createStepRealtimeFor(env: HubEnv): StepRealtime`
- `function cronCtx(ctx: TaskContext): CronCtx`
  Adapt the core `TaskContext`.
- `interface CronCtx extends PluginContext, BackgroundMethods`
  One cron run. `waitUntil` exists here because a scheduled invocation genuinely has one.
  - `readonly kind: 'cron'`
    See `JobCtx.kind`.
  - `waitUntil(promise: Promise<unknown>): void`
- `function customEventNameIssue(pluginId: string, name: string): string \| null`
  Why `name` is not a CUSTOM event `pluginId` may emit, or null when it may. Pure.
- `type Database = PgDatabase<PgQueryResultHKT, typeof schema>`
- `interface DatabaseHandle`
- `interface Decision`
  What `ctx.decide(...)` resolves to.
- `function defineTool<Input>(tool: Tool<Input>): Tool<Input>`
  Declare a tool. A thin helper, and its only job is to be the thing a plugin imports instead of the `Tool` type from a core path — but it is also where the two rules in this file's…
- `async function deleteIngestedDocument( ctx: PluginContext, input: { tenantId: string; source: string; externalId: string } ): Promise<boolean>`
  The item is gone upstream: delete its document, chunks, grants and stored original.
- `interface DeliveredEvent<E extends EventName = EventName>`
  One recorded event, as a subscriber receives it: re-read from `plugin_events`, re-validated.
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
  A Durable Object stub for one tenant, **with the tenant prefix built here rather than by the caller**.
- `const EMAIL_CATCH_ALL: "*"`
  The catch-all local part.
- `type EmailContext = TaskContext`
  What an email handler is given — the cron's context, for the same reasons.
- `function emailCtx(ctx: EmailContext): EmailCtx`
  Adapt the core `EmailContext`. The only place a plugin's email half names a core internal.
- `interface EmailCtx extends PluginContext, BackgroundMethods`
  One inbound message's context.
  - `waitUntil(promise: Promise<unknown>): void`
- `interface EmailHandler`
- `function emailLocalPart(address: string): string`
  `Receipts+Proton@Example.com` → `receipts`. Lower-cased (local parts are case-insensitive in practice, and Email Routing matches them that way) and cut at the first `+`, which is…
- `function emailSubaddress(address: string): string \| null`
  `receipts+proton@example.com` → `proton`; null when the address carries no tag.
- `type Emit = <E extends EventName>(event: E, input: EmitInput<E>) => Promise<EmittedEvent>`
- `interface EmitInput<E extends EventName>`
  The background `emit`: the tenant is named per call, as every background method takes it.
- `interface EmittedEvent`
  What `ctx.emit` answers.
- `function eventBinding<E extends EventName, Input = unknown>( event: E, spec: Omit<AgentEventBinding<E, Input>, 'event'> ): AgentEventBinding<E, Input>`
  Declare an OPT-IN: this agent may be started by `event` when a subject names it (an editor's "On submit, start" choice) — never by the event alone. Listed by…
- `interface EventContext extends JobContext`
  What an event handler is given: the job's context — its own DB client, config, logger, env — plus the event it is delivering. A plugin adapts it with `eventCtx(ctx)` from…
- `function eventCtx(ctx: EventContext): EventCtx`
  Adapt the host's `EventContext`. The only place a plugin's event half names a core internal.
- `interface EventCtx extends PluginContext`
  What an event handler works with, BOUND to the delivered event's tenant: nothing on it takes a tenant id, so a handler cannot reach another organisation through a method by…
  - `readonly tenantId: string`
    The event's organisation — the tenant predicate of every query the handler writes.
  - `enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>`
  - `enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>`
  - `nudge(entity: string, id?: string): Promise<void>`
    Nudge this organisation's open tabs. Awaited — there is no `waitUntil` in a job.
  - `emit: TenantEmit`
    Emit a follow-on event in the same organisation.
  - `features(): Promise<readonly string[]>`
    The organisation's feature keys — skip the work when your flag is off for it.
  - `storage(): StorageService`
    R2; write under `tenants/<ctx.tenantId>/<plugin id>/…`.
  - `durableObject<T extends Rpc.DurableObjectBranded \| undefined = undefined>( namespace: DurableObjectNamespace<T>, key?: string ): DurableObjectStub<T>`
  - `startAgentRun(input: Omit<StartAgentRunInput, 'tenantId'>): Promise<StartedAgentRun>`
    `startAgentRun` in this organisation (the route's own gates; each refusal throws). Pass an `idempotencyKey` derived from `event.id`. For "this event starts that agent" prefer the…
  - `startBoundAgent(agentKey: AgentKey \| string): Promise<StartedAgentRun>`
    Start the agent a SUBJECT named for THIS event — the form block's "On submit, start" choice, read from the plugin's own stored, published configuration, never from the payload a…
- `interface EventHandler<E extends EventName = EventName>`
  One subscription: a `ServerPlugin.eventHandlers` entry or an `APP_EVENT_HANDLERS` one. Each gets its OWN queued delivery per event, so one handler's failure retries alone. Throw…
- `type EventName = EventNameOf<InstalledShared>`
  Every event name an installed plugin declares. `never` while none does.
- `type EventPayload = EventPayloadOf<InstalledShared, E>`
  The parsed payload of event `E`, as the declaring plugin's schema outputs it.
- `function eventTrigger<E extends EventName, Input = unknown>( event: E, spec: Omit<AgentEventTrigger<E, Input>, 'event'> ): AgentEventTrigger<E, Input>`
  Declare an AUTOMATIC start in an agent definition: `triggers: [eventTrigger('sites.form.submitted', { where: p => p.formName === 'contact', input: p => ({ text: p.fields.message…
- `function fuseByRank<T>( dense: T[], lexical: T[], keyOf: (item: T) => string, k = RRF_K ): FusedItem<T>[]`
  Reciprocal Rank Fusion of two ordered candidate lists (best first). Pure.
- `interface FusedItem<T>`
- `function hasFeature(auth: Pick<PluginAuth, 'features'>, name: string): boolean`
  `true` when this deployment ships the surface AND this organisation has it yet.
- `interface HookCtx extends Pick<PluginContext, 'db'>`
  A lifecycle hook: `onTenantCreated`, `onTenantDeleted`, `seedDemo`.
  - `tenant: Tenant`
  - `tenantId: string`
  - `userId: string \| null`
    Who caused it — the signing-up user, the approving admin. Null for a system path.
  - `features: readonly string[]`
    The features this DEPLOYMENT ships. A hook that CREATES rows is the sharpest feature door there is, because it has no nav entry to hide behind: seed nothing for a surface this…
- `function identityFor(c: AppContext, pluginId: string): PluginIdentity`
  Both halves, bound to this request and this plugin's namespace.
- `type IdpAppRole = z.infer<typeof idpAppRoleSchema>`
- `async function ingestDocument( ctx: PluginContext, input: PluginIngestTextInput ): Promise<PluginIngestResult>`
  Index text. Small texts are indexed before this returns; larger ones return `queued`. No embeddings provider → 503 `ai_not_configured`, checked before anything is written.
- `async function ingestDocumentFile( ctx: PluginContext, input: PluginIngestFileInput ): Promise<PluginIngestResult>`
  Store a file in R2 and index it — text-like types now, binary ones (PDF, Office…) through the `document.convert` job. Unsupported type → 415 `unsupported_media_type`; no `FILES`…
- `async function ingestPlatformDocument( ctx: JobCtx \| CronCtx, input: PlatformDocumentInput ): Promise<PlatformDocumentResult>`
  Write (or re-write) a PLATFORM document — one every tenant can read, describing the app itself. Only from a job or a cron task (`JobCtx | CronCtx`), on the owner connection,…
- `class InvalidCustomEventError extends Error`
  A CUSTOM name a plugin may not emit. A TYPE, so the stream can say which code it was.
- `function isAdminLevel(session: RoleView): boolean`
  May administer members / invitations / keys: owner, admin, support, or global admin.
- `function isGlobalAdmin(session: RoleView): boolean`
  `users.isGlobalAdmin` — the platform flag, independent of any tenant role.
- `function isOwnerLevel(session: RoleView): boolean`
  Irreversible tenant actions: explicit `owner` (or global admin), NOT `manage Tenant`.
- `function isUniqueViolation(err: unknown): boolean`
  A unique / primary-key violation (`23505`), under either driver.
- `function jobCtx(ctx: JobContext): JobCtx`
  Adapt the core `JobContext`. The only place a plugin's job half names a core internal.
- `interface JobCtx extends PluginContext, BackgroundMethods`
  One queue message. `job.payload` is already narrowed to the variant this handler was registered for — `ServerPlugin.jobHandlers` is checked against the job types the plugin's own…
  - `readonly kind: 'job'`
    Which background context this is. A brand as much as a field: the few methods that only a job or a cron task may call (`ingestPlatformDocument`) take `JobCtx | CronCtx`, and the…
- `type JobEnvelope = z.infer<typeof jobEnvelopeSchema>`
- `type JobHandler = ( job: Extract<JobEnvelope, { type: T }>, ctx: JobContext ) => Promise<void>`
- `type JobInput = z.infer<typeof jobInputSchema>`
- `type JobOf = Extract<JobEnvelope, { type: T }>`
  The envelope narrowed to one `type` — what a handler receives.
- `type JobType = JobEnvelope['type']`
  Every job type this app knows, derived from the variants rather than kept beside them.
- `async function listAgents(): Promise<readonly AgentSummary[]>`
  Every registered agent — the kit's and every installed plugin's — as `{ key, title, description }`, the same catalogue `GET /api/agents` serves. For a plugin that lists or…
- `async function listBindableAgents(event: EventName \| string): Promise<BindableAgent[]>`
  The agents that opt in (`bindable`) to being started by `event` — what an editor's agent picker lists. The same list for every tenant: agents are code. A browser reads it through…
- `type Logger = pino.Logger`
- `async function memberCan( ctx: PluginContext, who: { tenantId: string; userId: string }, action: Actions, subject: Subjects ): Promise<boolean>`
  Does this person hold this grant in this tenant RIGHT NOW? For a public callback completing something a signed state started — an OAuth connection, a consent — where the state…
- `type MembershipRole = z.infer<typeof membershipRoleSchema>`
- `const noopTracer: Tracer`
  What a context carries when no sink is reachable (a unit test, a bare router).
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
- `async function openSecret(config: PluginConfig, sealed: string): Promise<string>`
  Decrypt what `sealSecret` produced. Throws on a value sealed under another key.
- `function pageWindow(query: PaginationQuery): { limit: number; offset: number }`
- `function pgErrorCode(err: unknown): string \| undefined`
  The Postgres SQLSTATE (`23505`, `40001`…) of a driver error, wherever it hangs: both drivers put `code` on their own error (postgres.js, Neon's `NeonDbError`) and drizzle wraps…
- `interface PickOptions<T>`
- `interface PickResult<T>`
- `interface PlatformDocumentInput`
- `interface PlatformDocumentResult`
- `class PlatformEmbeddingsError extends ServiceUnavailableError`
  503 `platform_embeddings_not_configured`: no `EMBEDDINGS_API_KEY` and no `[ai]` binding.
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
    The Worker bindings. A plugin reads the ones its own `plugin.json` declares; reaching for a core binding directly is usually the sign that a method is missing from this surface.
- `interface PluginDeprovisionResult`
  What `provision.deprovision` did in the tenant.
- `interface PluginHeaderItem`
  One item in the app's top bar — a search box, a help button. Rendered by the shell inside `Layout` for every signed-in page with a tenant, behind `guard`, inside its OWN…
- `type PluginHeaderPlacement = 'center' \| 'end'`
  Where in the top bar a plugin header item sits.
- `interface PluginIdentity`
  `identityFor(c, pluginId)`: sign a person in, or provision them.
- `interface PluginIdentityUser`
  A person as this module answers them: plain fields, never the row.
- `interface PluginIngestFileInput extends IngestCommon`
- `interface PluginIngestResult`
  What an ingest answers. `queued` means a `document.index` / `document.convert` job finishes it.
- `interface PluginIngestTextInput extends IngestCommon`
- `type PluginLogger = Pick<Logger, 'debug' \| 'info' \| 'warn' \| 'error'>`
  The four level methods, and deliberately no more.
- `interface PluginLoginMethodDeclaration`
  What a plugin declares; the host namespaces `id` as `<plugin id>:<id>` on the wire.
- `interface PluginMember`
  One row of `listMembers`: the membership and the person, plain fields.
- `type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]`
  One entry of the mount table in `api/index.ts`: prefix, router, optional gate.
- `interface PluginNavGroup`
  A nav group, placed relative to a named core group ("Organisation" by default).
  - `label?: string`
  - `before?: string`
    Insert before the core group with this label; appended when the label is not found.
  - `items: NavItem[]`
- `interface PluginProvision`
  Tenant-explicit user and membership writes with no session: SCIM, a directory sync.
- `type PluginPublicMount = readonly [string, Hono<AppEnv>, PluginPublicMountOptions?]`
  One UNAUTHENTICATED mount: prefix, router and optional guards — no gate, because a feature gate reads `auth.features` and there is no auth here. The prefix must be…
- `interface PluginPublicMountOptions`
  How the host guards one public mount before its router runs. Both are applied by the HOST (`api/index.ts`), never by the plugin's handlers, so every unauthenticated prefix is…
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
    Default `shell` — inside `Layout`, signed in with a tenant. `workspace` is the same, for a page that wants the whole space: the nav collapses to its icon rail, `<main>` has no…
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public' \| 'workspace'`
- `interface PluginSeedContext`
  Everything a plugin's `seedDemo` hook is given (`pnpm seed --demo`).
- `interface PluginSignInInput`
  What a plugin's IdP proved about the person, handed to `signIn`.
- `type PluginStructuredOptions = Omit< CallStructuredToolOptions<T>, 'model' \| 'maxTokens' > & { maxTokens?: number }`
  `callStructuredTool` minus what the runtime supplies.
- `type PluginToolLoopOptions = Omit< RunToolLoopOptions, 'model' \| 'maxTokens' \| 'approvals' \| 'runApproved' > & { maxTokens?: number }`
  `runToolLoop` minus what the runtime supplies.
- `function provisionFor(ctx: PluginContext, pluginId: string): PluginProvision`
  The cookie-free half: usable from any `PluginContext` — a public handler, a job, a cron.
- `async function prunePlatformDocuments( ctx: JobCtx \| CronCtx, input: { source: string; keepExternalIds: readonly string[] } ): Promise<number>`
  Delete the platform documents of `source` whose `externalId` is not in `keepExternalIds` — what a sync calls after ingesting the current set. Answers the number deleted; an empty…
- `const PUBLIC_MOUNT_ROOT: "/api/hooks"`
  The prefix every public mount lives under; the plugin's id is the next segment.
- `const PUBLIC_SITE_PAGE_CSP_HEADER: "x-public-site-page-csp"`
  A router's per-page additions to the public CSP (JSON, `PublicSiteCsp` shape): the CSP sources of a page that embeds something, without opening them on every other page of the…
- `function publicCtx(c: AppContext): PublicCtx`
  Build a public handler's context. The only function here that reads the Hono context.
- `interface PublicCtx extends PluginContext, BackgroundMethods`
  - `readonly appUrl: string`
    `APP_URL` — the origin a third party is told to call back, and to redirect a browser to.
  - `defer(fn: () => Promise<unknown>): void`
    As on `RequestCtx`: through `waitUntil`, never awaited, logged rather than thrown.
  - `notFound(message?: string, code?: string): never`
  - `badRequest(message?: string, code?: string, details?: unknown): never`
  - `forbidden(message?: string, code?: string): never`
  - `unauthorized(message?: string): never`
- `interface PublicSiteCsp`
  Developer-declared additions to the strict public CSP. Inline script stays banned.
- `interface PublicSiteFormPath`
- `interface PublicSitesDeclaration`
  A public website answered from the Worker on its own hostnames (`api/middleware/public-sites.ts`). The host owns the request's order: cache lookup, rate limit (misses only),…
- `interface Realtime`
  Everything a service needs to nudge: how to defer, and the hub binding. Built by `withAuth`.
- `function realtimeEvent( type: RealtimeEventType, tenantId: string, payload?: unknown ): RealtimeEvent`
- `async function recordActivity(db: Database, input: ActivityInput): Promise<void>`
- `async function recordUsage(db: Database, input: UsageInput): Promise<number \| null>`
  Returns the cost it froze onto the row (null when the model has no price).
- `function requestCtx(c: AppContext): RequestCtx`
  Build a plugin's request context from the core one.
- `interface RequestCtx extends PluginContext, PluginAuth`
  What a route handler is handed.
  - `readonly scope: AccessScope`
    Tenant-wide visibility scope — hand it to a predicate, never to a query as a tenant id.
  - `readonly groups: readonly GroupRef[]`
    The reader's groups in this organisation, each with the name of the TYPE it belongs to.
  - `readonly visibility: RequestVisibility`
    Read and write who may see one of this plugin's own rows — see `RequestVisibility`.
  - `guard(action: Actions, subject: Subjects): void`
    403 unless this role may `action` the `subject`. The KIND of thing, never the row.
  - `can(action: Actions, subject: Subjects): boolean`
    The same question without throwing — for branching, e.g. "may they also see the archived ones".
  - `hasFeature(name: string): boolean`
    `true` when this deployment ships the feature AND this organisation has it.
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
    Tell this organisation's open tabs that a family of rows moved. `entity` IS the query-key family root, so declaring it once covers the socket wiring.
  - `storage(): StorageService`
    R2, or a 503 `storage_not_configured` — loud, because a silently absent bucket loses bytes.
  - `emit: TenantEmit`
    Emit a declared plugin event (D42) in THIS organisation: validated (400), recorded, one delivery queued per subscriber — awaited, because the row is the durable half and a 400…
  - `durableObject<T extends Rpc.DurableObjectBranded \| undefined = undefined>( namespace: DurableObjectNamespace<T>, key?: string ): DurableObjectStub<T>`
    A per-tenant Durable Object stub. The plugin never spells the name; the prefix is structural.
  - `notFound(message?: string, code?: string): never`
  - `badRequest(message?: string, code?: string, details?: unknown): never`
  - `forbidden(message?: string, code?: string): never`
  - `unauthorized(message?: string): never`
  - `conflict(message?: string, code?: string, details?: unknown): never`
  - `unavailable(message?: string, code?: string): never`
  - `detached(): DetachedCtx`
    A snapshot of this context that outlives the handler.
  - `readonly realtime: Realtime`
    The realtime handle, for a plugin service that takes `realtime?` the way core services do.
- `interface RequestVisibility`
  Reading and writing who may see one of a plugin's own rows.
  - `resolve( input: { visibility?: ResourceVisibility; groupIds?: readonly string[] } \| undefined ): Promise<SetResourceGroupsInput>`
    Validate what a CLIENT asked for, against the caller's own groups. Absent input keeps the default, which is tenant-wide; `'tenant'` always clears the grants, because leaving stale…
  - `set(kind: string, resourceId: string, input: SetResourceGroupsInput): Promise<string[]>`
    Write the row's `visibility` and replace its grants, in ONE transaction, through the registry entry this `kind` names. Answers the group ids that were actually stored.
  - `grantsFor(kind: string, resourceIds: readonly string[]): Promise<Map<string, GroupRef[]>>`
    Which groups each of these rows is shared with, in ONE query — so a badge strip on a list costs one extra round trip rather than one per row.
- `function requireFeature(feature: FeatureName)`
- `async function resolveOwnerTenant( db: Database, config: Pick<AppConfig, 'TENANCY_MODE'>, ownerSlug?: string ): Promise<Tenant \| null>`
  The tenant that owns a public surface: the one tenant under `single`, the tenant named by `ownerSlug` under `multi`. Null when there is none, or when it is not `active`, so a…
- `interface ResourceGrantRow`
  One row of `grantsForResources`, before it is grouped by resource.
- `function rows<T = Record<string, unknown>>(result: unknown): T[]`
  The rows of a raw `db.execute(sql…)`, whichever driver ran it: postgres.js returns the array itself, Neon a `{ rows }` object. The only way code outside this file reads one (the…
- `interface ScheduledTask`
- `async function sealSecret(config: PluginConfig, plaintext: string): Promise<string>`
  Encrypt a credential for storage. The output is opaque base64; keep it in a `*_enc` column.
- `async function searchKnowledge( ctx: Pick<PluginContext, 'db' \| 'config' \| 'env'> & { scope: AccessScope }, input: SearchKnowledgeInput ): Promise<SearchKnowledgeResult>`
  The kit's hybrid knowledge search, for a plugin: the caller's tenant documents as its `AccessScope` may read them (narrowed by `sources`), plus — only when named — the platform…
- `interface SearchKnowledgeHit`
- `interface SearchKnowledgeInput`
- `interface SearchKnowledgeResult`
- `interface SeedCtx extends Pick<PluginContext, 'db'>`
  `pnpm seed --demo`, after the core block.
  - `tenantId: string`
  - `ownerId: string`
  - `demoId: (key: string) => string`
  - `log: (line: string) => void`
- `interface ServerPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `requires?: PluginRequires`
  - `mounts?: readonly PluginMount[]`
    Spread into the mount table of `api/index.ts`; the prefix is `/api/<id>` by convention.
  - `publicMounts?: readonly PluginPublicMount[]`
    Routes a third party calls with no session or key — an admin-consent callback, a webhook. Mounted BEFORE the authed mounts and without `authMiddleware`, under `/api/hooks/<id>`…
  - `publicSites?: PublicSitesDeclaration`
    Whole websites on hostnames of their own: on a claimed host this router answers every path and core is unreachable. Host claims are checked by `tests/config/plugins.test.ts`…
  - `loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]`
    Sign-in methods for the login page, read per request by `GET /auth/methods` (so `cfg` may decide: a dev-only method, one per configured connection). Each button navigates to its…
  - `ssoPolicy?: SsoPolicy`
    "SSO required" for the emails one of this plugin's connections claims (a DNS-verified domain): answer `{ required: true, methodId }` — `methodId` one of THIS plugin's…
  - `apiPrefixes?: readonly string[]`
    Extra path prefixes the Worker owns, unioned into `API_PREFIXES` — so an unmatched path under one is a JSON 404 rather than `index.html`. Adding one ALSO means adding it to…
  - `jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }`
    `type` → handler, covering EXACTLY the job variants `shared.jobs` declares. Merged into the consumer's dispatch table; each handler gets its own DB client and awaits everything,…
  - `agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }`
    Agent definitions, one per key in `shared.agentKeys`.
  - `prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }`
    Prompt registry entries, one per key in `shared.promptKeys`.
  - `agentTools?: (ctx: AgentToolContext) => Tool[] \| Promise<Tool[]>`
    Tools added to every agent run, beside the three built-in knowledge tools. Bound to the run's access scope, so a plugin tool reads what its REQUESTER may read and nothing more.…
  - `knowledgeSources?: (scope: AccessScope) => readonly string[] \| Promise<readonly string[]>`
    PLATFORM knowledge sources (`<id>:<kind>`, written with `ingestPlatformDocument`) the kit's `search_knowledge` tool also searches for this reader — chat and every agent run.…
  - `scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>`
    Cron expression → tasks, merged into `SCHEDULED_TASKS` (tasks on a cron core already runs are appended after core's). A cron core does NOT run is declared in `plugin.json`…
  - `emailHandlers?: readonly EmailHandler[]`
    Inbound email (Cloudflare Email Routing → the Worker's `email` handler), merged into `EMAIL_HANDLERS` in `api/email.ts` and matched on the recipient's local part (`receipts` takes…
  - `eventHandlers?: readonly EventHandler[]`
    Subscriptions to plugin events (D42) — this plugin's own or any other installed plugin's, named by `event` and declared in some `SharedPlugin.events`. Each entry gets its OWN…
  - `deploymentFeatures?: (config: AppConfig) => readonly string[]`
    Feature keys this plugin's own CONFIG switches on for the deployment, unioned with `FEATURES_ENABLED`, so an `environmentGated` flag can follow a plugin's vars rather than need a…
  - `grants?: Partial<Record<EffectiveRole, RoleGrant>>`
    Per-role CASL rules, applied after the core matrix — additive, never a replacement.
  - `uploadPaths?: readonly string[]`
    Prefixes where a NON-JSON body (a multipart file) gets the upload-path cap — 10 MB + 64 KB (`MAX_UPLOAD_PATH_BODY_BYTES`) — instead of the global 1 MB; a JSON body beneath one…
  - `rlsExcludedTables?: readonly string[]`
    Plugin tables with no `tenant_id`, unioned into `RLS_EXCLUDED_TABLES` with a reason each.
  - `unscopedAllowlist?: Readonly<Record<string, string>>`
    Source files the cross-tenant allow-list scan may skip, keyed the way that test keys its own: a path relative to `apps/web/` (`src/plugins/<id>/…`) mapped to the REASON it is…
  - `visibilityResources?: readonly VisibilityResource[]`
    Rows of this plugin that a group may restrict. Read by `services/access.ts`.
  - `hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> onTenantStatusChanged?: ( db: Database, tenantId: string, status: 'active' \| 'suspended', env: AppBindings ) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }`
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries: the analytics plugin reads `extensions.cubes` and friends from every installed plugin and narrows them with zod, failing loudly on anything it cannot…
- `interface SetResourceGroupsInput`
- `function sharedWithMyGroups( scope: AccessScope, junction: string, foreignKey: string, resourceId: SQL ): SQL`
  `exists (select 1 from <junction> j where j.<fk> = <resource>.id and j.group_id = any($ids))`.
- `interface SiftOptions<T>`
- `interface SiftResult<T>`
- `async function signState( config: PluginConfig, purpose: string, payload: Record<string, unknown>, opts: { ttlSeconds?: number } = {} ): Promise<string>`
  Sign `payload` for `purpose`. The result is URL-safe: `<body>.<signature>`, both base64url.
- `type SpanKind = 'agent' \| 'llm' \| 'tool' \| 'retrieval' \| 'embedding' \| 'job' \| 'span'`
  What a span IS — it picks the GenAI operation name and the backend's observation type.
- `interface SpanParams`
- `interface SsoRequirement`
  What a plugin's `ssoPolicy` answers for an email whose domain one of its connections claims.
- `type StartAgentRun = (input: StartAgentRunInput) => Promise<StartedAgentRun>`
- `interface StartAgentRunInput`
  - `agentKey: AgentKey`
    A core agent's key or one an installed plugin declared in its `SharedPlugin.agentKeys`.
  - `tenantId: string`
    The organisation the run belongs to — from the job's payload, never ambient.
  - `input: unknown`
    Validated against the agent's `inputSchema` here, and again before `run()`.
  - `idempotencyKey?: string`
    At most one run EVER per (tenant, agent, key): a second call returns the first call's run, whatever its status. Name the work (`receipt:<documentId>`), not the delivery.
  - `concurrencyKey?: string`
    At most one ACTIVE run per (tenant, agent, key) — the exclusive slot, narrowed. A new run may start once the previous one settles, which `idempotencyKey` never allows.
  - `triggeredBy?: string \| null`
    The user the run is on behalf of — `agent_runs.requested_by_user_id`, and the requester whose CURRENT access the run's tools are scoped to. Omitted, the run is system-triggered…
- `interface StartedAgentRun`
  - `runId: string`
  - `status: AgentRunStatus`
    `queued` for a new run; whatever the existing run's status is when `deduplicated`.
  - `deduplicated: boolean`
    The run already existed — the same `idempotencyKey`, or an active run holding the exclusive slot — and `runId` is THAT run. Nothing new was started.
- `interface StepCtx extends PluginContext`
  What a step body is handed: the base context, with a client that belongs to THIS step.
  - `name: string`
    The step's own name, so a log line can say which one it came from.
  - `realtime: StepRealtime`
    Nudges, collected and awaited before the step returns.
- `interface StepOptions`
  `step.do`'s options, narrowed to what the core workflow uses.
  - `retries?: { limit: number delay: WorkflowSleepDuration \| number backoff?: 'constant' \| 'linear' \| 'exponential' }`
  - `timeout?: WorkflowSleepDuration \| number`
- `interface StepRealtime`
  - `realtime: Realtime`
    The `Realtime` a core-shaped service takes as its trailing optional argument.
  - `settle(): Promise<void>`
    Await every send collected so far. Failures are swallowed — a nudge is never load-bearing.
  - `nudgeEntity(tenantId: string, entity: string, id?: string): Promise<void>`
  - `send(event: RealtimeEvent): Promise<void>`
  - `sendToUser(userId: string, event: RealtimeEvent): Promise<void>`
  - `sendToUsers(userIds: string[], event: RealtimeEvent): Promise<void>`
- `interface StorageService`
- `interface StoredObject extends StoredObjectMeta`
- `interface StoredObjectMeta`
- `async function streamChat(c: AppContext, options: StreamChatOptions): Promise<Response>`
  Stream one chat turn for a plugin route, as AG-UI (SSE, or protobuf when the client's `Accept` negotiates it). Call it as the route's return value:
- `type StreamChatEmit = (name: string, value: unknown) => Promise<void>`
  Emit one CUSTOM event named `<plugin id>.<what>`. Any other name is refused.
- `interface StreamChatOptions`
- `interface StreamChatResult`
  What the turn produced, handed to `onFinish` and returned in `RUN_FINISHED.result`.
- `interface StreamChatToolCtx extends ToolCtx`
  What a plugin's tool builder is handed: the usual `ToolCtx`, on the stream's client, plus `emit`.
  - `emit: StreamChatEmit`
- `interface StreamChatTurn`
  One prior turn of the plugin's own conversation, oldest first.
- `type Subjects = CoreSubject \| PluginSubject \| FeatureSubject`
- `type Tenant = typeof tenants.$inferSelect`
- `type TenantEmit = <E extends EventName>( event: E, input: TenantEmitInput<E> ) => Promise<EmittedEvent>`
- `type TenantEmitInput = Omit<EmitInput<E>, 'tenantId'>`
  The same input where the context is already bound to one tenant (a request, a run, a handler).
- `interface Tool<Input = unknown>`
  A tool the model may call. `handler` runs it; a tool WITHOUT a handler is terminal (its input is the answer).
- `interface ToolApproval`
  An answered gate, as the loop consumes it — keyed by `toolCallId` in {@link RunToolLoopOptions.approvals}, built by the runtime from the resolved rows. The agent never assembles…
- `interface ToolCallParams`
- `function toolCtx(ctx: AgentToolContext): ToolCtx`
  Adapt the runtime's tool context. The only place a plugin's tools name a core internal.
- `interface ToolCtx`
  What `ServerPlugin.agentTools(ctx)` is handed, spelled as the plugin surface rather than as the runtime's internal shape.
  - `db: Database`
  - `config: PluginConfig`
  - `env: PluginBindings`
  - `scope: AccessScope`
  - `tenantId: string`
    The run's tenant — `scope.tenantId`, surfaced because every query needs it.
  - `can: AbilityCheck`
    Does the requester hold this CASL grant now? Offer a tool that writes only when they hold your subject's manage (`ctx.can('manage', MY_SUBJECT)`) — never decide that from…
  - `maxDocumentChars?: number`
    The CALLER's budget for one document window, in characters. An agent run's is far larger than a chat turn's.
  - `requesterUrls: ReadonlySet<string>`
    The http(s) URLs the person behind this call wrote themselves, normalised with `new URL()` and no fragment: the chat person's own messages, or an agent run's input when a person…
  - `storage(): StorageService`
    R2 (the `FILES` bucket), or a 503 `storage_not_configured` — the same service every other context's `storage()` returns. Read and write under `tenants/<ctx.tenantId>/<plugin…
  - `features(): Promise<readonly string[]>`
    The feature keys the run's organisation has — what `ctx.features(tenantId)` answers in a job. A plugin whose tool belongs to a flagged surface returns `[]` when the flag is off,…
- `function toolInputSchema(schema: ZodType): JsonSchema`
  JSON Schema (draft-07, `$schema` stripped) for a tool input.
- `interface ToolLoopCheckpoint`
  Everything a later attempt needs to carry on where this one stopped. Deliberately symmetric: what {@link RunToolLoopOptions.onCheckpoint} hands you is exactly what {@link…
- `interface ToolLoopResult`
- `function traceChatClient( client: ChatClient, trace: TraceHandle, meta: TraceClientMeta, tracer?: Tracer ): ChatClient`
  Wrap a client so each call emits a `chat <model>` child of `trace`. Unchanged when tracing is off.
- `interface TraceHandle`
- `interface Tracer`
- `async function traceStep<T>( params: StepParams, fn: () => Promise<T>, describe?: (result: T) => StepOutcome ): Promise<T>`
  Run `fn` as a child span of the active one (and make it active for anything `fn` traces in turn). `describe` turns the result into the span's output — keep it small; it is…
- `function tracingEnabled(tracer: Tracer): boolean`
  `true` when this request/run is actually recording spans — cheap enough to branch on.
- `async function transaction<T>( db: PluginContext['db'], fn: (tx: PluginContext['db']) => Promise<T> ): Promise<T>`
  Run several writes as one transaction.
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the core tabs. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the core links. A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one they…
  - `header?: readonly PluginHeaderItem[]`
    Top-bar items (`PluginHeaderItem`): merged across plugins, ordered by `order` then plugin id, rendered by `PluginHeaderSlot` in `Layout`'s `headerCenter` / `headerEnd`.
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries for the browser, the UI twin of `ServerPlugin.extensions`: another plugin reads every installed plugin's entries under a key with `uiExtensions(key)` (from…
- `function usageFeatureIssue(pluginId: string, feature: string): string \| null`
  Why `feature` is not a usage label `pluginId` may record under, or null when it may. Pure.
- `type User = typeof users.$inferSelect`
- `function validate<T extends ZodSchema, Target extends keyof ValidationTargets>( target: Target, schema: T )`
- `async function verifyState<T = Record<string, unknown>>( config: PluginConfig, purpose: string, token: string ): Promise<T \| null>`
  The payload `signState` signed for this `purpose`, or `null`. `p` and `exp` are stripped, so the caller gets back exactly what it put in. Parse the result with zod before trusting…
- `interface VisibilityResource`
  What it takes to be a resource a group can restrict.
- `async function withAgentTrace<T>( name: string, ctx: AgentTraceContext, fn: (trace: TraceHandle) => Promise<T> ): Promise<T>`
  Run `fn` inside one span named for `name` (`invoke_agent <name>` unless `spanName` overrides it), ACTIVE for everything `fn` does, so tools, retrieval and embeddings nest under…
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

> The two escape hatches that read the WHOLE installed set.

- `function allTables(): AllTables`
  The whole schema namespace, for a library that takes one (drizzle-cube's `createCubeApp({ schema })` is the case this exists for).
- `type AllTables = typeof schema`
  The merged drizzle schema: every core table AND every installed plugin's.
- `function extensions(key: string): readonly unknown[]`
  Everything every installed plugin contributed under one `extensions` key.
- `function extensionSources(key: string): readonly string[]`
  Which plugins contributed under a key — for the error message when one of them fails to parse.

### `@/plugins/api/ui-wiring`

The only host module a plugin's `ui/index.ts` may import — it ships in the main bundle.

> The WIRING half of the UI kit — the only host module a plugin's `ui/index.ts` may import.

- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `const featureGuard: (feature: NavGuard, guard: NavGuard) => NavGuard`
  `featureGuard(MY_FEATURE, { action: 'read', subject: 'Thing' })` → the flag AND the permission.
- `const isGuardList: (guard: NavGuard) => guard is readonly NavGuard[]`
  `Array.isArray` widens a `readonly T[]` to `any[]` rather than narrowing the union, so this.
- `type NavConfig = (NavItem \| NavGroup)[]`
- `interface NavGroup`
- `type NavGuard = \| 'admin' \| 'globalAdmin' \| { action: string; subject: string } \| { feature: string } \| readonly NavGuard[]`
  Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics), a CASL `{ action, subject }` pair for per-page checks, a feature flag, or a list meaning AND. Strings,…
- `interface NavItem`
- `interface PluginHeaderItem`
  One item in the app's top bar — a search box, a help button. Rendered by the shell inside `Layout` for every signed-in page with a tenant, behind `guard`, inside its OWN…
- `type PluginHeaderPlacement = 'center' \| 'end'`
  Where in the top bar a plugin header item sits.
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
    Default `shell` — inside `Layout`, signed in with a tenant. `workspace` is the same, for a page that wants the whole space: the nav collapses to its icon rail, `<main>` has no…
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public' \| 'workspace'`
- `interface QuickLink`
- `interface TabConfig`
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the core tabs. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the core links. A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one they…
  - `header?: readonly PluginHeaderItem[]`
    Top-bar items (`PluginHeaderItem`): merged across plugins, ordered by `order` then plugin id, rendered by `PluginHeaderSlot` in `Layout`'s `headerCenter` / `headerEnd`.
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries for the browser, the UI twin of `ServerPlugin.extensions`: another plugin reads every installed plugin's entries under a key with `uiExtensions(key)` (from…
- `function useNavGuard(): (guard: NavGuard \| undefined) => boolean`

### `@/plugins/api/ui`

Components and hooks, for a lazy PAGE. Never for the UI entry.

> The COMPONENTS half of the UI kit — for a plugin's PAGES, never for its `ui/index.ts`.

- `function AccessBadge({ visibility, groups, className = '', }: { visibility: ResourceVisibility groups: GroupRef[] className?: string })`
  The read-only counterpart: a lock and the group names, for a list row.
- `function AccessPicker({ visibility, groupIds, available, onChange, tenantName, disabled = false, idPrefix = 'access', }: AccessPickerProps)`
- `interface AccessPickerProps`
- `function AlertModal({ isOpen, title, message, type = 'info', onClose }: AlertModalProps)`
  One-button acknowledgement on the `<dialog>` Modal.
- `const api: { get<T>(url: string, options?: ApiRequestOptions<T>): Promise<T>; post<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; put<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; patch<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>):… (truncated)`
  GET → no error toast by default (queries render their own error state); mutations → toast.
- `class ApiError extends Error`
  Thrown for every non-2xx response. `body` is the parsed error envelope.
- `interface ApiRequestOptions<T = unknown> extends Omit<RequestInit, 'body'>`
- `interface Breadcrumb`
- `function Breadcrumbs({ items, className = '', }: { items: Breadcrumb[] className?: string })`
  The trail above a page title, on its own for a surface with no `PageHeader` (an editor toolbar).
- `function ConfirmModal({ isOpen, title, message, confirmText = 'Confirm', cancelText = 'Cancel', confirmButtonClass = 'btn-primary', isLoading = false, onCancel, onConfirm, }: ConfirmModalProps)`
  Two-button confirmation on the `<dialog>` Modal.
- `function DocumentCard({ card, to, dense = false, footer }: DocumentCardProps)`
- `interface DocumentCardProps`
- `function DocumentLink({ to, title, meta, status, id }: DocumentLinkProps)`
- `function documentLinkProps(card: DocumentCardData): DocumentLinkProps`
  A `DocumentCard` as a one-liner: everything that survives the width, nothing that does not.
- `interface DocumentLinkProps`
- `function EmptyState({ icon: Icon, message, description, action, className = '', size = 'md', }: EmptyStateProps)`
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
- `function MarkdownImageLink({ src, alt }: Pick<ComponentProps<'img'>, 'src' \| 'alt'>)`
- `function Modal({ open, onClose, title, children, actions, closeButton = true, className = '', }: ModalProps)`
  `<dialog>`-based modal: native focus trap, Escape and backdrop close, `aria-modal` for free. Controlled — the caller owns `open`. Falls back to the `open` attribute where…
- `interface ModalProps`
- `type NavGuard = \| 'admin' \| 'globalAdmin' \| { action: string; subject: string } \| { feature: string } \| readonly NavGuard[]`
  Coarse role flags for routing (`AdminRoute` / `GlobalAdminRoute` semantics), a CASL `{ action, subject }` pair for per-page checks, a feature flag, or a list meaning AND. Strings,…
- `interface NavigationChecks`
- `function navigationEntries( plugins: readonly AnyUiPlugin[], { canAccess, can }: NavigationChecks ): NavigationEntry[]`
  The list, pure: the plugins and the checks are passed in, so it is unit-tested directly.
- `interface NavigationEntry`
- `function notifyUnauthorized(error: ApiError): void`
  Invoke the 401 handler. A stale session makes every in-flight query fail at once, so calls within the same tick are coalesced into ONE handler invocation. Called by `request()`…
- `function PageHeader({ title, description, breadcrumbs, badge, actions, className = '', }: PageHeaderProps)`
  Page title row: breadcrumbs, a modest title (no enormous headings), description, actions.
- `function PaginationControls({ pagination, onPageChange, isLoading = false, className = '', }: PaginationControlsProps)`
  "Showing X to Y of Z" + Previous/Next. Renders nothing for a single page.
- `function SearchInput({ value, onChange, placeholder = 'Search…', debounceMs = 300, className = '', size = 'md', 'aria-label': ariaLabel = 'Search', }: SearchInputProps)`
  Debounced search box with a clear button, for server-side search on index pages.
- `function SectionPanel({ title, description, actions, children, className = '', flush = false, }: SectionPanelProps)`
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
  Register the global 401 handler. One handler; the last registration wins. Pass `null` to remove it. `AuthProvider` calls this with the redirect-to-login behaviour.
- `function showToast(message: string, type: ToastType, duration?: number): void`
  Show a toast from anywhere, inside or outside React.
- `default function SideNav({ items = navigationConfig, footer, forceCollapsed, }: SideNavProps)`
- `function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string })`
  Placeholder lines on their own, for panels that stay mounted while loading.
- `interface TabConfig`
- `function timeAgo(value: Date \| null \| undefined, fallback = 'never'): string`
  "3 hours ago" — for activity feeds and "last seen".
- `interface Toast`
- `function ToastContainer()`
  Bottom-right stack. Mount once.
- `type ToastType = 'success' \| 'error' \| 'warning' \| 'info'`
- `function uiExtensions(key: string): readonly unknown[]`
- `function uiExtensionSources(key: string): readonly string[]`
  Which plugins contributed under a key — for the error message when one of them does not parse.
- `const UNLABELLED_NAV_GROUP: "Pages"`
  The heading an unlabelled nav group gets in a list.
- `function URLTabs({ tabs, defaultTab, param = 'tab', className = '', actions, }: URLTabsProps)`
  Tabs whose active state lives in `?tab=`, so deep links and back/forward work.
- `function useAuth(): AuthContextValue`
- `function useFeature(name: FeatureName): boolean`
  Is a feature on for this session? Reads `session.features` — the array the server resolved — and NEVER the ability: `manage all` covers `access` on every `Feature:` subject, so an…
- `function useGroups(typeId?: string, enabled = true)`
- `function useGroupTypes(enabled = true)`
- `function useMyGroups()`
  Every member may read their OWN groups — the profile list, and what the picker offers them.
- `function useNavigationEntries(): NavigationEntry[]`
  `navigationEntries` for the signed-in reader and the installed plugins.
- `function usePermissions()`
- `function useTenancyMode(): TenancyMode`
  `'single'` hides OrgSwitcher, /select-tenant and org create/delete.
- `const useToastStore: UseBoundStore<StoreApi<ToastStore>>`
- `function VisibilityModal({ open, onClose, name, visibility, groups, available, tenantName, isSaving = false, onSave, }: VisibilityModalProps)`
- `interface VisibilityModalProps`

### `@/plugins/types`

`ServerPlugin` and `UiPlugin` — the slots a plugin fills.

> The Worker half of a plugin: what a plugin contributes to the server and to the UI.

- `type AnyServerPlugin = ServerPlugin<SharedPlugin>`
  The element type of the barrels — a plugin whose shared half is not narrowed.
- `type AnyUiPlugin = UiPlugin<SharedPlugin>`
- `interface PluginHeaderItem`
  One item in the app's top bar — a search box, a help button. Rendered by the shell inside `Layout` for every signed-in page with a tenant, behind `guard`, inside its OWN…
- `type PluginHeaderPlacement = 'center' \| 'end'`
  Where in the top bar a plugin header item sits.
- `type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]`
  One entry of the mount table in `api/index.ts`: prefix, router, optional gate.
- `interface PluginNavGroup`
  A nav group, placed relative to a named core group ("Organisation" by default).
  - `label?: string`
  - `before?: string`
    Insert before the core group with this label; appended when the label is not found.
  - `items: NavItem[]`
- `type PluginPublicMount = readonly [string, Hono<AppEnv>, PluginPublicMountOptions?]`
  One UNAUTHENTICATED mount: prefix, router and optional guards — no gate, because a feature gate reads `auth.features` and there is no auth here. The prefix must be…
- `interface PluginPublicMountOptions`
  How the host guards one public mount before its router runs. Both are applied by the HOST (`api/index.ts`), never by the plugin's handlers, so every unauthenticated prefix is…
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
    Default `shell` — inside `Layout`, signed in with a tenant. `workspace` is the same, for a page that wants the whole space: the nav collapses to its icon rail, `<main>` has no…
- `type PluginRouteTier = 'shell' \| 'noTenant' \| 'public' \| 'workspace'`
- `interface PluginSeedContext`
  Everything a plugin's `seedDemo` hook is given (`pnpm seed --demo`).
- `interface PublicSiteCsp`
  Developer-declared additions to the strict public CSP. Inline script stays banned.
- `interface PublicSiteFormPath`
- `interface PublicSitesDeclaration`
  A public website answered from the Worker on its own hostnames (`api/middleware/public-sites.ts`). The host owns the request's order: cache lookup, rate limit (misses only),…
- `interface ServerPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `requires?: PluginRequires`
  - `mounts?: readonly PluginMount[]`
    Spread into the mount table of `api/index.ts`; the prefix is `/api/<id>` by convention.
  - `publicMounts?: readonly PluginPublicMount[]`
    Routes a third party calls with no session or key — an admin-consent callback, a webhook. Mounted BEFORE the authed mounts and without `authMiddleware`, under `/api/hooks/<id>`…
  - `publicSites?: PublicSitesDeclaration`
    Whole websites on hostnames of their own: on a claimed host this router answers every path and core is unreachable. Host claims are checked by `tests/config/plugins.test.ts`…
  - `loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]`
    Sign-in methods for the login page, read per request by `GET /auth/methods` (so `cfg` may decide: a dev-only method, one per configured connection). Each button navigates to its…
  - `ssoPolicy?: SsoPolicy`
    "SSO required" for the emails one of this plugin's connections claims (a DNS-verified domain): answer `{ required: true, methodId }` — `methodId` one of THIS plugin's…
  - `apiPrefixes?: readonly string[]`
    Extra path prefixes the Worker owns, unioned into `API_PREFIXES` — so an unmatched path under one is a JSON 404 rather than `index.html`. Adding one ALSO means adding it to…
  - `jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }`
    `type` → handler, covering EXACTLY the job variants `shared.jobs` declares. Merged into the consumer's dispatch table; each handler gets its own DB client and awaits everything,…
  - `agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }`
    Agent definitions, one per key in `shared.agentKeys`.
  - `prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }`
    Prompt registry entries, one per key in `shared.promptKeys`.
  - `agentTools?: (ctx: AgentToolContext) => Tool[] \| Promise<Tool[]>`
    Tools added to every agent run, beside the three built-in knowledge tools. Bound to the run's access scope, so a plugin tool reads what its REQUESTER may read and nothing more.…
  - `knowledgeSources?: (scope: AccessScope) => readonly string[] \| Promise<readonly string[]>`
    PLATFORM knowledge sources (`<id>:<kind>`, written with `ingestPlatformDocument`) the kit's `search_knowledge` tool also searches for this reader — chat and every agent run.…
  - `scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>`
    Cron expression → tasks, merged into `SCHEDULED_TASKS` (tasks on a cron core already runs are appended after core's). A cron core does NOT run is declared in `plugin.json`…
  - `emailHandlers?: readonly EmailHandler[]`
    Inbound email (Cloudflare Email Routing → the Worker's `email` handler), merged into `EMAIL_HANDLERS` in `api/email.ts` and matched on the recipient's local part (`receipts` takes…
  - `eventHandlers?: readonly EventHandler[]`
    Subscriptions to plugin events (D42) — this plugin's own or any other installed plugin's, named by `event` and declared in some `SharedPlugin.events`. Each entry gets its OWN…
  - `deploymentFeatures?: (config: AppConfig) => readonly string[]`
    Feature keys this plugin's own CONFIG switches on for the deployment, unioned with `FEATURES_ENABLED`, so an `environmentGated` flag can follow a plugin's vars rather than need a…
  - `grants?: Partial<Record<EffectiveRole, RoleGrant>>`
    Per-role CASL rules, applied after the core matrix — additive, never a replacement.
  - `uploadPaths?: readonly string[]`
    Prefixes where a NON-JSON body (a multipart file) gets the upload-path cap — 10 MB + 64 KB (`MAX_UPLOAD_PATH_BODY_BYTES`) — instead of the global 1 MB; a JSON body beneath one…
  - `rlsExcludedTables?: readonly string[]`
    Plugin tables with no `tenant_id`, unioned into `RLS_EXCLUDED_TABLES` with a reason each.
  - `unscopedAllowlist?: Readonly<Record<string, string>>`
    Source files the cross-tenant allow-list scan may skip, keyed the way that test keys its own: a path relative to `apps/web/` (`src/plugins/<id>/…`) mapped to the REASON it is…
  - `visibilityResources?: readonly VisibilityResource[]`
    Rows of this plugin that a group may restrict. Read by `services/access.ts`.
  - `hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> onTenantStatusChanged?: ( db: Database, tenantId: string, status: 'active' \| 'suspended', env: AppBindings ) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }`
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries: the analytics plugin reads `extensions.cubes` and friends from every installed plugin and narrows them with zod, failing loudly on anything it cannot…
- `interface UiPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `routes: readonly PluginRoute[]`
  - `nav?: readonly PluginNavGroup[]`
  - `settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]`
    Extra `/settings?tab=` tabs, appended after the core tabs. `can` is the caller's ability.
  - `homeLinks?: readonly QuickLink[]`
    Quick links for the Home page, merged AHEAD of the core links. A feature somebody reaches from Home is one they were told about; a plugin that only adds a nav item is one they…
  - `header?: readonly PluginHeaderItem[]`
    Top-bar items (`PluginHeaderItem`): merged across plugins, ordered by `order` then plugin id, rendered by `PluginHeaderSlot` in `Layout`'s `headerCenter` / `headerEnd`.
  - `queryKeys?: Readonly<Record<string, unknown>>`
    Families merged into `queryKeys`; every root must start with `<id>:`.
  - `agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>`
    `AGENT_FORMS` entries for the agents this plugin registers. Optional per agent: `formFor` falls back to a form generated from the agent's own JSON Schema, then to a JSON textarea.
  - `extensions?: Readonly<Record<string, readonly unknown[]>>`
    Cross-plugin registries for the browser, the UI twin of `ServerPlugin.extensions`: another plugin reads every installed plugin's entries under a key with `uiExtensions(key)` (from…

### `@/db/schema/kit`

The build-time schema symbols. A `pgTable(...)` runs at module scope, so these cannot be injected.

> The schema kit — the build-time symbols a plugin's table file needs at MODULE scope.

- `const activityEvents: table "activity_events" { id, tenantId, userId, type, subjectType, subjectId, metadata, createdAt }`
- `const groupMembers: table "group_members" { tenantId, groupId, userId, createdAt }`
- `const groups: table "groups" { createdAt, updatedAt, id, tenantId, groupTypeId, name, description }`
- `const groupTypes: table "group_types" { createdAt, updatedAt, id, tenantId, name, description }`
- `function membershipIsolation()`
  `users` has no `tenant_id` — a user is global and belongs to MANY tenants through `tenant_users` — so it is scoped by MEMBERSHIP of the active tenant instead.
- `const RESOURCE_VISIBILITY_VALUES: readonly ["tenant", "groups"]`
  The values of a resource's `visibility` column: `tenant` = every member of the organisation, `groups` = only the groups granted in that resource's junction table (plus the owner…
- `function tenantIsolation(table: string, column = sql`tenant_id`)`
  ONE policy predicate, shared by every table. Do not inline a copy per table: drizzle-kit diffs the rendered SQL text, so a stray space shows up as N spurious `ALTER POLICY`…
- `function tenantRef(tenants: { id: AnyPgColumn })`
  `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`.
- `const tenants: table "tenants" { createdAt, updatedAt, id, name, slug, status, externalOrgId, idpSyncedAt, seedDataCreated, lastAccessedAt }`
- `const tenantUsers: table "tenant_users" { tenantId, userId, role, source, idpSyncedAt, joinedAt, invitedByUserId }`
- `function timestamps()`
  `created_at` / `updated_at` as `timestamptz`, both defaulting to now(). Spread into a table.
- `const users: table "users" { createdAt, updatedAt, id, email, name, avatarUrl, isGlobalAdmin, globalAdminSource, emailVerifiedAt, lastLoginAt, blockedAt, blockedSource }`

### `@rocketflare/shared/plugins/api`

What a plugin's CONTRACT module imports: the error envelope, pagination, `SharedPlugin`.

> The shared plugin API — what a plugin's CONTRACT module imports from the host.

- `type Actions = (typeof ACTIONS)[number]`
- `type AgentKeyOf = NonNullable<DeclaredBy<S, 'agentKeys'>>[number]`
  The agent keys one plugin declares — what its `ServerPlugin.agents` must cover, exhaustively.
- `type ApiErrorBody = z.infer<typeof apiErrorSchema>`
- `const apiErrorSchema: z.ZodObject<{ error: z.ZodString; statusCode: z.ZodNumber; code: z.ZodOptional<z.ZodString>; details: z.ZodOptional<z.ZodUnknown>; }, z.core.$strip>`
  The ONE error envelope every API response uses — from `app.onError`, `notFound`, the zValidator hook, and `ApiError` thrown in routes. The UI's `api-client.ts` parses this into…
- `type DeclaredBy = Extract<P, Record<K, unknown>> extends infer Declaring ? Declaring extends Record<K, unknown> ? Declaring[K] : never : never`
  The value of an OPTIONAL `SharedPlugin` field across the whole barrel, skipping the plugins that do not declare it.
- `const ERROR_CODES: { readonly validationFailed: "validation_failed"; readonly unauthorized: "unauthorized"; readonly sessionExpired: "session_expired"; readonly forbidden: "forbidden"; readonly notFound: "not_found"; readonly conflict: "conflict"; readonly rateLimited: "rate_limited"; readonly pendingApproval: "pendin… (truncated)`
  Well-known `code` values shared by API and UI. Extend per app.
- `type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]`
- `const EVENT_NAME_RE: RegExp`
  One segment after the plugin id: lower-case, digits, `-` and `_`, dot-separated.
- `type EventNameOf = Extract< EventsOf<S> extends infer R ? (R extends unknown ? keyof R : never) : never, string >`
  The event names one plugin (or a union of plugins) declares.
- `function eventNameProblem(pluginId: string, name: string): string \| null`
  `null` when `name` is an event `pluginId` may declare, else the sentence saying why not: it must be `<pluginId>.<something>`, well formed, and never in the core `kit.` namespace.…
- `type EventPayloadOf = E extends unknown ? EventsOf<S> extends infer R ? R extends Record<E, infer Schema> ? Schema extends ZodTypeAny ? TypeOf<Schema> : never : never : never : never`
  The parsed payload of event `E`, from whichever plugin in `S` declares it. A union of names gives the union of their payloads, so a handler list typed over every event still…
- `type EventsOf = NonNullable<DeclaredBy<S, 'events'>>`
  The events one plugin declares — its `events` record. Distributive, so over a UNION of plugins it is a union of records; `EventNameOf` / `EventPayloadOf` read names and payloads…
- `interface FeatureDefinition`
- `type FeatureFlagState = z.infer<typeof featureFlagStateSchema>`
- `type FeatureKeyOf = Extract< NonNullable<DeclaredBy<S, 'features'>> extends infer F ? F extends unknown ? keyof F : never : never, string >`
  The feature keys one plugin declares (the keys of its `features` record). Distributive, so a UNION of plugins yields every plugin's keys — plain `keyof (A | B)` is only the keys…
- `type FeatureRolloutUnit = z.infer<typeof featureRolloutUnitSchema>`
- `type GroupRef = z.infer<typeof groupRefSchema>`
- `function isPluginId(value: string): boolean`
- `function isSameOriginPath(value: string): boolean`
  True only for a same-origin path: `/settings`, `/search?q=a#x`; never `//host` or `https://…`.
- `type JobInput = z.infer<typeof jobInputSchema>`
- `type JobOf = Extract<JobEnvelope, { type: T }>`
  The envelope narrowed to one `type` — what a handler receives.
- `type JobType = JobEnvelope['type']`
  Every job type this app knows, derived from the variants rather than kept beside them.
- `type JobTypeOf = TypeOf< NonNullable<DeclaredBy<S, 'jobs'>>[number]['shape']['type'] >`
  The job types one plugin declares — what its `ServerPlugin.jobHandlers` must cover.
- `type JobVariant = ZodObject<{ type: ZodTypeAny } & ZodRawShape>`
  One job envelope variant: a zod object whose `type` is the discriminant. Spelled as zod's own discriminated-union option type, so a variant that would not compose into…
- `type MembershipRole = z.infer<typeof membershipRoleSchema>`
- `function paginatedResponse<T extends z.ZodTypeAny>(item: T)`
  `paginatedResponse(itemSchema)` → `{ items: Item[], pagination: PaginationMeta }`
- `function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta`
- `type PaginationMeta = z.infer<typeof paginationMetaSchema>`
- `const paginationMetaSchema: z.ZodObject<{ page: z.ZodNumber; pageSize: z.ZodNumber; total: z.ZodNumber; totalPages: z.ZodNumber; }, z.core.$strip>`
- `type PaginationQuery = z.infer<typeof paginationQuerySchema>`
- `const paginationQuerySchema: z.ZodObject<{ page: z.ZodDefault<z.ZodCoercedNumber<unknown>>; pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>; }, z.core.$strip>`
  Page-based pagination (page-based). Query: `?page=1&pageSize=25`.
- `const PLUGIN_ID_RE: RegExp`
  `^[a-z][a-z0-9-]*$` and never containing `rocketflare`: an id carrying the app's original name would be rewritten with everything else when the app is renamed.
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
    Feature-flag definitions keyed by flag key, merged into `FEATURE_FLAGS`. A flag is configuration, not a permission: gate with `hasFeature(auth.features, …)`, never with CASL.
  - `readonly config?: ZodRawShape`
    Extra `[vars]` / secrets, merged into the Worker's config schema (`apps/web/src/config.ts`). A zod raw shape rather than a whole object so the core schema stays one schema.
  - `readonly realtimeRoots?: readonly string[]`
    Query-key roots that `access.changed` should invalidate: a plugin whose rows carry `visibility` has to be re-fetched when somebody's group membership moves under them.
  - `readonly events?: Readonly<Record<string, ZodTypeAny>>`
    Events this plugin EMITS (D42), name → payload schema. Every name is `<id>.<name>` — this plugin's id, a dot, then lower-case segments (`sites.form.submitted`) — and never `kit.`.…
- `type SubjectOf = NonNullable<DeclaredBy<S, 'subjects'>>[number]`
  The CASL subjects one plugin declares.
- `type Subjects = CoreSubject \| PluginSubject \| FeatureSubject`

### `'../api' (apps/cli/src/plugins/api.ts)`

The CLI half: the one `fetch` site, the exit codes, the output helpers.

> The CLI plugin API — what a plugin's command module imports from the CLI.

- `type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>`
  `action()` in `cli.ts`: builds the context from the global options and maps any error.
- `type AnyCliPlugin = CliPlugin<SharedPlugin>`
- `interface ApiClient`
- `interface ApiResponse<T>`
- `class CliApiError extends CliError`
- `class CliError extends Error`
- `interface CliPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `register(program: Command, action: ActionWrapper): void`
    Add `program.command(...)` entries. The top-level command name is the plugin's id.
- `interface Column<Row>`
- `interface CommandContext`
- `interface ContextOptions`
- `const EXIT_ERROR: 1`
- `const EXIT_FORBIDDEN: 3`
- `const EXIT_NOT_LOGGED_IN: 2`
- `const EXIT_OK: 0`
  CLI error types and the exit-code mapping: 0 ok · 1 error · 2 not logged in · 3 forbidden. Commands throw; `cli.ts` catches once, prints once, and sets `process.exitCode`.
- `function exitCodeForStatus(status: number): number`
- `function formatCell(value: unknown): string`
- `function formatDate(value: Date \| string \| null \| undefined): string`
  `2026-09-01 07:54` in local time, or `-` for null.
- `function formatJson(value: unknown): string`
- `function formatPagination(meta: { page: number totalPages: number total: number pageSize: number }): string`
  `Page 2/5 · 113 items` — footer for paginated lists.
- `function neutralise(text: string): string`
  Text that came from a server or another user, made inert for a terminal: C0 controls (a carriage return becomes a line break, a tab and a line break stay), DEL and C1 are removed,…
- `class NotLoggedInError extends CliError`
- `type OpenLike = (url: string) => Promise<unknown>`
- `interface Output`
- `function publicClient(ctx: CommandContext): ApiClient`
  An unauthenticated client (health checks).
- `type QueryValue = string \| number \| boolean \| undefined \| null`
- `function renderTable<Row>(rows: readonly Row[], columns: readonly Column<Row>[]): string`
  Left-aligned columns separated by two spaces; header in bold; `-` for null/undefined.
- `interface RequestOptions<T>`
- `function requireClient(ctx: CommandContext): ApiClient`
  An authenticated client, or `NotLoggedInError` (exit 2) when no key is configured.

### `'./types' (apps/cli/src/plugins/types.ts)`

`CliPlugin` and the `action()` wrapper it registers with.

> The CLI half of a plugin.

- `type ActionWrapper = ( handler: (ctx: CommandContext, command: Command) => Promise<void> ) => (...args: unknown[]) => Promise<void>`
  `action()` in `cli.ts`: builds the context from the global options and maps any error.
- `type AnyCliPlugin = CliPlugin<SharedPlugin>`
- `interface CliPlugin<S extends SharedPlugin = SharedPlugin>`
  - `shared: S`
  - `register(program: Command, action: ActionWrapper): void`
    Add `program.command(...)` entries. The top-level command name is the plugin's id.

### `@testkit/integration`

The harness: a real database, the real Hono app, real bindings-shaped stubs, the provider tree.

> `@testkit/integration` — the host's test harness, as a DECLARED entry.

- `async function aguiFrames(res: Response): Promise<KitAguiEvent[]>`
  Parse an AG-UI SSE body into the typed events it carried. Spec AG-UI frames are `data:` only — a test that finds an `event:` line here should fail, so `sseEventFields` exists to…
- `function aguiTypes(events: KitAguiEvent[]): string[]`
  The event types of a run, in order — what a sequence assertion actually cares about.
- `function bearerHeader(key: string): Record<string, string>`
- `async function cleanDatabase(db: Database): Promise<void>`
  TRUNCATE every table in `public` (drizzle's bookkeeping lives in schema `drizzle`).
- `function createExecutionContext(): TestExecutionContext`
- `async function createTestApiKey( db: Database, tenantId: string, userId: string, overrides: Partial<Omit<NewApiKey, 'keyHash' \| 'keyPrefix'>> = {} )`
  A tenant API key created by `userId` (who must be a member). Returns the plaintext `key` for an `Authorization: Bearer` header plus the stored row.
- `function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv`
  A fresh env per call (KV and queue state are not shared between calls). Vars come from process.env with .env.test-compatible defaults; pass `overrides` to change any of them.
- `function createTestGlobalAdmin(db: Database, overrides: Partial<NewUser> = {})`
  A platform staff account (`users.isGlobalAdmin`), the gate for `/api/admin/*`.
- `function createTestQueryClient()`
  A fresh client with retries off so failing queries settle immediately.
- `async function createTestSession( db: Database, userId: string, tenantId?: string \| null, options: { expiresInDays?: number; ip?: string; userAgent?: string } = {} ): Promise<string>`
  A cookie session for `userId` (optionally pinned to `tenantId`). Returns the COOKIE VALUE — the raw token; the row stores only `hashToken(token)`.
- `async function createTestTenant(db: Database, overrides: Partial<NewTenant> = {})`
- `async function createTestTenantWithUser( db: Database, role: MembershipRole = 'owner', userOverrides: Partial<NewUser> = {}, tenantOverrides: Partial<NewTenant> = {} )`
  Tenant + one member in one call (default `owner`).
- `async function createTestUser(db: Database, overrides: Partial<NewUser> = {})`
- `function customEvents(events: KitAguiEvent[]): { name: string; value: unknown }[]`
  The kit CUSTOM events of a run, `name` → `value`, in order.
- `async function deliverEvents(env: TestEnv, db: Database): Promise<EventDelivery[]>`
- `async function dispatchScheduled( cron: string, env: AppBindings, ctx: Pick<ExecutionContext, 'waitUntil'>, registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS ): Promise<TaskReport[]>`
  Runs every task registered for `cron` and returns a per-task report (used by tests).
- `function errorResponse(status: number, error = 'Error', code?: string)`
- `interface EventDelivery`
- `const IDS: { user: string; otherUser: string; tenant: string; otherTenant: string; }`
- `async function json<T = unknown>(res: Response): Promise<T>`
- `function jsonResponse(body: unknown, status = 200)`
  JSON `Response` helper for `vi.stubGlobal('fetch', …)`.
- `async function linkUserToTenant( db: Database, userId: string, tenantId: string, role: MembershipRole = 'member', invitedByUserId: string \| null = null )`
  Membership row. `support` is allowed here because fixtures must reach states only /admin mints.
- `function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse`
  A signed-in owner of Acme by default. Pass `tenant: null` for the "no active tenant" states; `permissions` follows `tenant.role`/`user.isGlobalAdmin` unless given explicitly.
- `function makeTenant(overrides: Partial<TenantSummary> = {}): TenantSummary`
- `function makeUser(overrides: Partial<User> = {}): User`
- `const notFoundResponse: () => Response`
- `function paged<T>(items: T[], pageSize = 25)`
  `{ items, pagination }` for a one-page list response.
- `interface PlatformChatCall`
  What the platform model was asked, one entry per chat call.
- `interface PlatformChatTurn`
  One model turn of {@link scriptPlatformChat}: what the platform model answers.
- `interface RecordedMessage<T = unknown>`
- `function renderWithProviders( ui: ReactElement, { route = '/', queryClient = createTestQueryClient(), session, ...options }: ProviderOptions = {} )`
- `async function request( path: string, init: RequestInit = {}, options: RequestOptions = {} ): Promise<Response>`
- `function requestBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>, key: string)`
  Body of the JSON request made to `"METHOD /path"`, or undefined if never called.
- `interface RequestOptions`
- `type RouteTable = Record< string, Response \| unknown \| ((init: RequestInit \| undefined, url: URL) => Response \| unknown) >`
  `{ 'GET /api/members': handler }`; the method defaults to GET when omitted from the key.
- `function rulesFor( role: MembershipRole \| null, isGlobalAdmin = false, features: string[] = [] )`
  Packed rules EXACTLY as the server emits them for this role (same matrix, same packer).
- `const SCHEDULED_TASKS: Record<string, ScheduledTask[]>`
  Core tasks plus every installed plugin's. A plugin naming a cron core already runs APPENDS to it — each task is try/caught on its own, so a plugin's failure cannot stop core's…
- `interface ScheduledTask`
- `function scriptPlatformChat( env: { AI?: unknown }, script: PlatformChatTurn[] \| ((call: PlatformChatCall, index: number) => PlatformChatTurn) ): PlatformChatCall[]`
  Script the PLATFORM chat model — the `AI` binding's stub — so a request resolves a real chat client through the real seam (`resolveChat` → `platformChat` → the Workers AI adapter)…
- `const SESSION_COOKIE_NAME: "__Host-session"`
  The login cookie. `middleware/csrf.ts` re-exports this so the CSRF check names the same cookie.
- `function sessionCookieHeader(token: string): Record<string, string>`
  `{ Cookie }` header for a token from `createTestSession`.
- `function setupTestDatabase(): Database`
  Shared pooled handle for fixtures/assertions (max 5 connections per fork).
- `function stubFetch(routes: RouteTable = {})`
  Stub `fetch` from a route table. Keys are `"METHOD /path"` (path compared without the query string); unmatched requests 404 with the shared envelope. Returns the mock for call…
- `function stubHealthFetch(info: Record<string, unknown> = {})`
  Stub `fetch` so `/api/health` answers with the given app info; everything else 404s.
- `function stubs(env: TestEnv)`
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

> `@testkit/unit` — builders for the plugin context family.

- `interface BackgroundCtxOptions extends BaseOptions`
  What every background builder accepts beyond the base.
- `interface CronCtxOptions extends BackgroundCtxOptions`
- `type FakeCronCtx = CronCtx & RecordsAgentRuns`
- `type FakeEmailCtx = EmailCtx & RecordsAgentRuns`
- `type FakeJobCtx = JobCtx & RecordsAgentRuns`
- `type FakeRequestCtx = RequestCtx & { readonly deferred: ReadonlyArray<() => Promise<unknown>> settle(): Promise<void> }`
  What a fake request context carries beyond the real one: the deferred work it collected.
- `type FakeWorkflowCtx = WorkflowCtx & { readonly recorded: ReturnType<typeof createFakeWorkflowStep> }`
  The fake step recorder, so a test can assert the NAMES a run asked for and their order.
- `function makeCronCtx(options: CronCtxOptions): FakeCronCtx`
- `function makeEmailCtx(options: CronCtxOptions): FakeEmailCtx`
  One inbound message's context (`emailHandlers`), through the kit's own `emailCtx` adapter.
- `function makeJobCtx(options: BackgroundCtxOptions): FakeJobCtx`
  One queue message's context, through the kit's own `jobCtx` adapter.
- `function makeRequestCtx(options: RequestCtxOptions): FakeRequestCtx`
  A `RequestCtx` with no request behind it.
- `function makeToolCtx(options: ToolCtxOptions): ToolCtx`
  What `ServerPlugin.agentTools(ctx)` is handed, through the kit's own `toolCtx` adapter.
- `function makeWorkflowCtx(options: WorkflowCtxOptions): FakeWorkflowCtx`
  A `WorkflowCtx` over a recording step.
- `interface RecordedAgentRun`
  One `ctx.startAgentRun` call, as a background builder recorded it.
- `interface RecordsAgentRuns`
  What a fake background context carries beyond the real one: every `startAgentRun` call, in order, with what it answered or threw — so "the job started exactly one run, with this…
- `interface RequestCtxOptions extends BaseOptions`
- `interface ToolCtxOptions extends BaseOptions`
- `interface WorkflowCtxOptions extends BaseOptions`

## Your own host files, and what the manifest writes outside your roots

- **`@/host/<id>/*`** — `apps/web/src/host/<id>/`, code the plugin seeded through `hostFiles`
  and the developer owns since (a generated content module, say). A plugin may import its OWN
  id's directory and no other (`tests/helpers/plugins.ts`); it resolves through the existing
  `@/*` alias, so no tsconfig, Vite or wrangler change. Not ledgered: the kit provides none of it.
- **`skills`** — `skills/<dir>/` → `.claude/skills/<dir>/`, `<dir>` being `<id>` or `<id>-*`.
  Replaced on upgrade, deleted on remove.
- **`claudeHooks`** — `{ "<Event>": [{ "command", "matcher"?, "timeout"? }] }`, merged into
  `.claude/settings.json`. A command is only `node "$CLAUDE_PROJECT_DIR/.claude/skills/<dir>/<script>"`
  (plus plain flags) over a script one of its declared skills ships; the skill directory is how the
  plugin's entries are found again. Replaced on upgrade, removed exactly on remove.
- **`hostFiles`** — `[{ "path", "from" }]`, a file or a directory seeded into `docs/<id>/`,
  `apps/web/public/<id>/` or `apps/web/src/host/<id>/` only where absent. Never touched by
  upgrade, left in place by remove.
- **`coreEdits`** and **`appOwned`** — anchored lines in a core file, and paths inside the
  plugin's own roots that the developer owns (`apps/web/src/plugins/CLAUDE.md`).

## Surface ledger

The machine-readable half of this file: one line per member the kit provides,
`entry :: kind :: name :: signature`.

**It is one side of a set difference.** What a plugin USES is derived from its own imports rather
than declared by its author (`usesOf` in `scripts/lib/surface.mjs`), and whatever it names that
this block does not carry is what fails an install — symbol by symbol, with the replacement import
where the symbol has merely moved entry. So there is no version to predict, no range to parse, and
nothing in the comparison that can throw.

```text
@/plugins/api :: type :: AbilityCheck :: type AbilityCheck = (action: Actions, subject: Subjects) => boolean
@/plugins/api :: interface :: AccessScope :: interface AccessScope
@/plugins/api :: type :: Actions :: type Actions = (typeof ACTIONS)[number]
@/plugins/api :: interface :: ActivityInput :: interface ActivityInput
@/plugins/api :: function :: affected :: function affected(result: unknown): number
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
@/plugins/api :: member :: AgentCtx.storage :: storage(): StorageService
@/plugins/api :: member :: AgentCtx.emit :: emit: TenantEmit
@/plugins/api :: member :: AgentCtx.prompt :: prompt(vars?: Record<string, string | undefined>): Promise<string>
@/plugins/api :: member :: AgentCtx.step :: step( key: string, label: string, status: 'running' | 'done' | 'error', detail?: string ): Promise<void>
@/plugins/api :: member :: AgentCtx.checkCancelled :: checkCancelled(): Promise<void>
@/plugins/api :: member :: AgentCtx.once :: once<T>(key: string, fn: () => Promise<T>): Promise<T>
@/plugins/api :: member :: AgentCtx.toolLoop :: toolLoop(options: PluginToolLoopOptions): Promise<ToolLoopResult>
@/plugins/api :: member :: AgentCtx.structured :: structured<T>(options: PluginStructuredOptions<T>): Promise<T>
@/plugins/api :: member :: AgentCtx.decide :: decide: AgentDecide
@/plugins/api :: member :: AgentCtx.interrupt :: interrupt(ask: AgentInterruptAsk): Promise<AgentInterruptAnswer>
@/plugins/api :: member :: AgentCtx.chatModel :: readonly chatModel: { readonly provider: AiProvider; readonly model: string }
@/plugins/api :: interface :: AgentDecide :: interface AgentDecide
@/plugins/api :: interface :: AgentEventBinding :: interface AgentEventBinding<E extends EventName = EventName, Input = unknown>
@/plugins/api :: interface :: AgentEventTrigger :: interface AgentEventTrigger<E extends EventName = EventName, Input = unknown>
@/plugins/api :: interface :: AgentInterruptAnswer :: interface AgentInterruptAnswer
@/plugins/api :: interface :: AgentInterruptAsk :: interface AgentInterruptAsk
@/plugins/api :: interface :: AgentSummary :: interface AgentSummary
@/plugins/api :: interface :: AgentTraceContext :: interface AgentTraceContext extends Omit<TraceParams, 'name'>
@/plugins/api :: class :: AiNotConfiguredError :: class AiNotConfiguredError extends ServiceUnavailableError
@/plugins/api :: type :: AnyServerPlugin :: type AnyServerPlugin = ServerPlugin<SharedPlugin>
@/plugins/api :: function :: anyTermTsquery :: function anyTermTsquery(query: string): string | null
@/plugins/api :: type :: AnyUiPlugin :: type AnyUiPlugin = UiPlugin<SharedPlugin>
@/plugins/api :: type :: AppRouter :: type AppRouter = Hono<AppEnv>
@/plugins/api :: interface :: BackgroundMethods :: interface BackgroundMethods
@/plugins/api :: member :: BackgroundMethods.enqueue :: enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
@/plugins/api :: member :: BackgroundMethods.enqueueMany :: enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
@/plugins/api :: member :: BackgroundMethods.nudge :: nudge(tenantId: string, entity: string, id?: string): Promise<void>
@/plugins/api :: member :: BackgroundMethods.durableObject :: durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>( namespace: DurableObjectNamespace<T>, tenantId: string, key?: string ): DurableObjectStub<T>
@/plugins/api :: member :: BackgroundMethods.features :: features(tenantId: string): Promise<readonly string[]>
@/plugins/api :: member :: BackgroundMethods.storage :: storage(): StorageService
@/plugins/api :: member :: BackgroundMethods.startAgentRun :: startAgentRun(input: StartAgentRunInput): Promise<StartedAgentRun>
@/plugins/api :: member :: BackgroundMethods.emit :: emit: Emit
@/plugins/api :: type :: BindableAgent :: type BindableAgent = z.infer<typeof bindableAgentSchema>
@/plugins/api :: function :: candidatePoolSize :: function candidatePoolSize(limit: number): number
@/plugins/api :: function :: chatModelAvailable :: async function chatModelAvailable( ctx: Pick<PluginContext, 'db' | 'config' | 'env'>, tenantId: string, promptKey: string ): Promise<boolean>
@/plugins/api :: function :: createRouter :: function createRouter(): Hono<AppEnv>
@/plugins/api :: function :: createStepRealtimeFor :: function createStepRealtimeFor(env: HubEnv): StepRealtime
@/plugins/api :: function :: cronCtx :: function cronCtx(ctx: TaskContext): CronCtx
@/plugins/api :: interface :: CronCtx :: interface CronCtx extends PluginContext, BackgroundMethods
@/plugins/api :: member :: CronCtx.kind :: readonly kind: 'cron'
@/plugins/api :: member :: CronCtx.waitUntil :: waitUntil(promise: Promise<unknown>): void
@/plugins/api :: function :: customEventNameIssue :: function customEventNameIssue(pluginId: string, name: string): string | null
@/plugins/api :: type :: Database :: type Database = PgDatabase<PgQueryResultHKT, typeof schema>
@/plugins/api :: interface :: DatabaseHandle :: interface DatabaseHandle
@/plugins/api :: interface :: Decision :: interface Decision
@/plugins/api :: function :: defineTool :: function defineTool<Input>(tool: Tool<Input>): Tool<Input>
@/plugins/api :: function :: deleteIngestedDocument :: async function deleteIngestedDocument( ctx: PluginContext, input: { tenantId: string; source: string; externalId: string } ): Promise<boolean>
@/plugins/api :: interface :: DeliveredEvent :: interface DeliveredEvent<E extends EventName = EventName>
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
@/plugins/api :: const :: EMAIL_CATCH_ALL :: const EMAIL_CATCH_ALL: "*"
@/plugins/api :: type :: EmailContext :: type EmailContext = TaskContext
@/plugins/api :: function :: emailCtx :: function emailCtx(ctx: EmailContext): EmailCtx
@/plugins/api :: interface :: EmailCtx :: interface EmailCtx extends PluginContext, BackgroundMethods
@/plugins/api :: member :: EmailCtx.waitUntil :: waitUntil(promise: Promise<unknown>): void
@/plugins/api :: interface :: EmailHandler :: interface EmailHandler
@/plugins/api :: function :: emailLocalPart :: function emailLocalPart(address: string): string
@/plugins/api :: function :: emailSubaddress :: function emailSubaddress(address: string): string | null
@/plugins/api :: type :: Emit :: type Emit = <E extends EventName>(event: E, input: EmitInput<E>) => Promise<EmittedEvent>
@/plugins/api :: interface :: EmitInput :: interface EmitInput<E extends EventName>
@/plugins/api :: interface :: EmittedEvent :: interface EmittedEvent
@/plugins/api :: function :: eventBinding :: function eventBinding<E extends EventName, Input = unknown>( event: E, spec: Omit<AgentEventBinding<E, Input>, 'event'> ): AgentEventBinding<E, Input>
@/plugins/api :: interface :: EventContext :: interface EventContext extends JobContext
@/plugins/api :: function :: eventCtx :: function eventCtx(ctx: EventContext): EventCtx
@/plugins/api :: interface :: EventCtx :: interface EventCtx extends PluginContext
@/plugins/api :: member :: EventCtx.tenantId :: readonly tenantId: string
@/plugins/api :: member :: EventCtx.enqueue :: enqueue(input: JobInput, options?: { delaySeconds?: number }): Promise<JobEnvelope>
@/plugins/api :: member :: EventCtx.enqueueMany :: enqueueMany(inputs: readonly JobInput[], options?: { delaySeconds?: number }): Promise<void>
@/plugins/api :: member :: EventCtx.nudge :: nudge(entity: string, id?: string): Promise<void>
@/plugins/api :: member :: EventCtx.emit :: emit: TenantEmit
@/plugins/api :: member :: EventCtx.features :: features(): Promise<readonly string[]>
@/plugins/api :: member :: EventCtx.storage :: storage(): StorageService
@/plugins/api :: member :: EventCtx.durableObject :: durableObject<T extends Rpc.DurableObjectBranded | undefined = undefined>( namespace: DurableObjectNamespace<T>, key?: string ): DurableObjectStub<T>
@/plugins/api :: member :: EventCtx.startAgentRun :: startAgentRun(input: Omit<StartAgentRunInput, 'tenantId'>): Promise<StartedAgentRun>
@/plugins/api :: member :: EventCtx.startBoundAgent :: startBoundAgent(agentKey: AgentKey | string): Promise<StartedAgentRun>
@/plugins/api :: interface :: EventHandler :: interface EventHandler<E extends EventName = EventName>
@/plugins/api :: type :: EventName :: type EventName = EventNameOf<InstalledShared>
@/plugins/api :: type :: EventPayload :: type EventPayload = EventPayloadOf<InstalledShared, E>
@/plugins/api :: function :: eventTrigger :: function eventTrigger<E extends EventName, Input = unknown>( event: E, spec: Omit<AgentEventTrigger<E, Input>, 'event'> ): AgentEventTrigger<E, Input>
@/plugins/api :: function :: fuseByRank :: function fuseByRank<T>( dense: T[], lexical: T[], keyOf: (item: T) => string, k = RRF_K ): FusedItem<T>[]
@/plugins/api :: interface :: FusedItem :: interface FusedItem<T>
@/plugins/api :: function :: hasFeature :: function hasFeature(auth: Pick<PluginAuth, 'features'>, name: string): boolean
@/plugins/api :: interface :: HookCtx :: interface HookCtx extends Pick<PluginContext, 'db'>
@/plugins/api :: member :: HookCtx.tenant :: tenant: Tenant
@/plugins/api :: member :: HookCtx.tenantId :: tenantId: string
@/plugins/api :: member :: HookCtx.userId :: userId: string | null
@/plugins/api :: member :: HookCtx.features :: features: readonly string[]
@/plugins/api :: function :: identityFor :: function identityFor(c: AppContext, pluginId: string): PluginIdentity
@/plugins/api :: type :: IdpAppRole :: type IdpAppRole = z.infer<typeof idpAppRoleSchema>
@/plugins/api :: function :: ingestDocument :: async function ingestDocument( ctx: PluginContext, input: PluginIngestTextInput ): Promise<PluginIngestResult>
@/plugins/api :: function :: ingestDocumentFile :: async function ingestDocumentFile( ctx: PluginContext, input: PluginIngestFileInput ): Promise<PluginIngestResult>
@/plugins/api :: function :: ingestPlatformDocument :: async function ingestPlatformDocument( ctx: JobCtx | CronCtx, input: PlatformDocumentInput ): Promise<PlatformDocumentResult>
@/plugins/api :: class :: InvalidCustomEventError :: class InvalidCustomEventError extends Error
@/plugins/api :: function :: isAdminLevel :: function isAdminLevel(session: RoleView): boolean
@/plugins/api :: function :: isGlobalAdmin :: function isGlobalAdmin(session: RoleView): boolean
@/plugins/api :: function :: isOwnerLevel :: function isOwnerLevel(session: RoleView): boolean
@/plugins/api :: function :: isUniqueViolation :: function isUniqueViolation(err: unknown): boolean
@/plugins/api :: function :: jobCtx :: function jobCtx(ctx: JobContext): JobCtx
@/plugins/api :: interface :: JobCtx :: interface JobCtx extends PluginContext, BackgroundMethods
@/plugins/api :: member :: JobCtx.kind :: readonly kind: 'job'
@/plugins/api :: type :: JobEnvelope :: type JobEnvelope = z.infer<typeof jobEnvelopeSchema>
@/plugins/api :: type :: JobHandler :: type JobHandler = ( job: Extract<JobEnvelope, { type: T }>, ctx: JobContext ) => Promise<void>
@/plugins/api :: type :: JobInput :: type JobInput = z.infer<typeof jobInputSchema>
@/plugins/api :: type :: JobOf :: type JobOf = Extract<JobEnvelope, { type: T }>
@/plugins/api :: type :: JobType :: type JobType = JobEnvelope['type']
@/plugins/api :: function :: listAgents :: async function listAgents(): Promise<readonly AgentSummary[]>
@/plugins/api :: function :: listBindableAgents :: async function listBindableAgents(event: EventName | string): Promise<BindableAgent[]>
@/plugins/api :: type :: Logger :: type Logger = pino.Logger
@/plugins/api :: function :: memberCan :: async function memberCan( ctx: PluginContext, who: { tenantId: string; userId: string }, action: Actions, subject: Subjects ): Promise<boolean>
@/plugins/api :: type :: MembershipRole :: type MembershipRole = z.infer<typeof membershipRoleSchema>
@/plugins/api :: const :: noopTracer :: const noopTracer: Tracer
@/plugins/api :: function :: notify :: async function notify(db: Database, input: NotifyInput, realtime?: Realtime): Promise<void>
@/plugins/api :: interface :: NotifyInput :: interface NotifyInput
@/plugins/api :: function :: notifyMany :: async function notifyMany( db: Database, userIds: string[], input: Omit<NotifyInput, 'userId'>, realtime?: Realtime )
@/plugins/api :: function :: nudge :: function nudge(rt: Realtime | undefined, event: RealtimeEvent): void
@/plugins/api :: function :: nudgeEntity :: function nudgeEntity( realtime: Realtime | undefined, tenantId: string, entity: string, id?: string ): void
@/plugins/api :: function :: nudgeUser :: function nudgeUser(rt: Realtime | undefined, userId: string, event: RealtimeEvent): void
@/plugins/api :: function :: nudgeUsers :: function nudgeUsers( rt: Realtime | undefined, userIds: string[], event: RealtimeEvent ): void
@/plugins/api :: function :: openSecret :: async function openSecret(config: PluginConfig, sealed: string): Promise<string>
@/plugins/api :: function :: pageWindow :: function pageWindow(query: PaginationQuery): { limit: number; offset: number }
@/plugins/api :: function :: pgErrorCode :: function pgErrorCode(err: unknown): string | undefined
@/plugins/api :: interface :: PickOptions :: interface PickOptions<T>
@/plugins/api :: interface :: PickResult :: interface PickResult<T>
@/plugins/api :: interface :: PlatformDocumentInput :: interface PlatformDocumentInput
@/plugins/api :: interface :: PlatformDocumentResult :: interface PlatformDocumentResult
@/plugins/api :: class :: PlatformEmbeddingsError :: class PlatformEmbeddingsError extends ServiceUnavailableError
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
@/plugins/api :: interface :: PluginDeprovisionResult :: interface PluginDeprovisionResult
@/plugins/api :: interface :: PluginHeaderItem :: interface PluginHeaderItem
@/plugins/api :: type :: PluginHeaderPlacement :: type PluginHeaderPlacement = 'center' | 'end'
@/plugins/api :: interface :: PluginIdentity :: interface PluginIdentity
@/plugins/api :: interface :: PluginIdentityUser :: interface PluginIdentityUser
@/plugins/api :: interface :: PluginIngestFileInput :: interface PluginIngestFileInput extends IngestCommon
@/plugins/api :: interface :: PluginIngestResult :: interface PluginIngestResult
@/plugins/api :: interface :: PluginIngestTextInput :: interface PluginIngestTextInput extends IngestCommon
@/plugins/api :: type :: PluginLogger :: type PluginLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
@/plugins/api :: interface :: PluginLoginMethodDeclaration :: interface PluginLoginMethodDeclaration
@/plugins/api :: interface :: PluginMember :: interface PluginMember
@/plugins/api :: type :: PluginMount :: type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]
@/plugins/api :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/api :: member :: PluginNavGroup.label :: label?: string
@/plugins/api :: member :: PluginNavGroup.before :: before?: string
@/plugins/api :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/api :: interface :: PluginProvision :: interface PluginProvision
@/plugins/api :: type :: PluginPublicMount :: type PluginPublicMount = readonly [string, Hono<AppEnv>, PluginPublicMountOptions?]
@/plugins/api :: interface :: PluginPublicMountOptions :: interface PluginPublicMountOptions
@/plugins/api :: interface :: PluginRequires :: interface PluginRequires
@/plugins/api :: interface :: PluginRoute :: interface PluginRoute
@/plugins/api :: member :: PluginRoute.path :: path: string
@/plugins/api :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/api :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/api :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/api :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public' | 'workspace'
@/plugins/api :: interface :: PluginSeedContext :: interface PluginSeedContext
@/plugins/api :: interface :: PluginSignInInput :: interface PluginSignInInput
@/plugins/api :: type :: PluginStructuredOptions :: type PluginStructuredOptions = Omit< CallStructuredToolOptions<T>, 'model' | 'maxTokens' > & { maxTokens?: number }
@/plugins/api :: type :: PluginToolLoopOptions :: type PluginToolLoopOptions = Omit< RunToolLoopOptions, 'model' | 'maxTokens' | 'approvals' | 'runApproved' > & { maxTokens?: number }
@/plugins/api :: function :: provisionFor :: function provisionFor(ctx: PluginContext, pluginId: string): PluginProvision
@/plugins/api :: function :: prunePlatformDocuments :: async function prunePlatformDocuments( ctx: JobCtx | CronCtx, input: { source: string; keepExternalIds: readonly string[] } ): Promise<number>
@/plugins/api :: const :: PUBLIC_MOUNT_ROOT :: const PUBLIC_MOUNT_ROOT: "/api/hooks"
@/plugins/api :: const :: PUBLIC_SITE_PAGE_CSP_HEADER :: const PUBLIC_SITE_PAGE_CSP_HEADER: "x-public-site-page-csp"
@/plugins/api :: function :: publicCtx :: function publicCtx(c: AppContext): PublicCtx
@/plugins/api :: interface :: PublicCtx :: interface PublicCtx extends PluginContext, BackgroundMethods
@/plugins/api :: member :: PublicCtx.appUrl :: readonly appUrl: string
@/plugins/api :: member :: PublicCtx.defer :: defer(fn: () => Promise<unknown>): void
@/plugins/api :: member :: PublicCtx.notFound :: notFound(message?: string, code?: string): never
@/plugins/api :: member :: PublicCtx.badRequest :: badRequest(message?: string, code?: string, details?: unknown): never
@/plugins/api :: member :: PublicCtx.forbidden :: forbidden(message?: string, code?: string): never
@/plugins/api :: member :: PublicCtx.unauthorized :: unauthorized(message?: string): never
@/plugins/api :: interface :: PublicSiteCsp :: interface PublicSiteCsp
@/plugins/api :: interface :: PublicSiteFormPath :: interface PublicSiteFormPath
@/plugins/api :: interface :: PublicSitesDeclaration :: interface PublicSitesDeclaration
@/plugins/api :: interface :: Realtime :: interface Realtime
@/plugins/api :: function :: realtimeEvent :: function realtimeEvent( type: RealtimeEventType, tenantId: string, payload?: unknown ): RealtimeEvent
@/plugins/api :: function :: recordActivity :: async function recordActivity(db: Database, input: ActivityInput): Promise<void>
@/plugins/api :: function :: recordUsage :: async function recordUsage(db: Database, input: UsageInput): Promise<number | null>
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
@/plugins/api :: member :: RequestCtx.emit :: emit: TenantEmit
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
@/plugins/api :: function :: resolveOwnerTenant :: async function resolveOwnerTenant( db: Database, config: Pick<AppConfig, 'TENANCY_MODE'>, ownerSlug?: string ): Promise<Tenant | null>
@/plugins/api :: interface :: ResourceGrantRow :: interface ResourceGrantRow
@/plugins/api :: function :: rows :: function rows<T = Record<string, unknown>>(result: unknown): T[]
@/plugins/api :: interface :: ScheduledTask :: interface ScheduledTask
@/plugins/api :: function :: sealSecret :: async function sealSecret(config: PluginConfig, plaintext: string): Promise<string>
@/plugins/api :: function :: searchKnowledge :: async function searchKnowledge( ctx: Pick<PluginContext, 'db' | 'config' | 'env'> & { scope: AccessScope }, input: SearchKnowledgeInput ): Promise<SearchKnowledgeResult>
@/plugins/api :: interface :: SearchKnowledgeHit :: interface SearchKnowledgeHit
@/plugins/api :: interface :: SearchKnowledgeInput :: interface SearchKnowledgeInput
@/plugins/api :: interface :: SearchKnowledgeResult :: interface SearchKnowledgeResult
@/plugins/api :: interface :: SeedCtx :: interface SeedCtx extends Pick<PluginContext, 'db'>
@/plugins/api :: member :: SeedCtx.tenantId :: tenantId: string
@/plugins/api :: member :: SeedCtx.ownerId :: ownerId: string
@/plugins/api :: member :: SeedCtx.demoId :: demoId: (key: string) => string
@/plugins/api :: member :: SeedCtx.log :: log: (line: string) => void
@/plugins/api :: interface :: ServerPlugin :: interface ServerPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api :: member :: ServerPlugin.shared :: shared: S
@/plugins/api :: member :: ServerPlugin.requires :: requires?: PluginRequires
@/plugins/api :: member :: ServerPlugin.mounts :: mounts?: readonly PluginMount[]
@/plugins/api :: member :: ServerPlugin.publicMounts :: publicMounts?: readonly PluginPublicMount[]
@/plugins/api :: member :: ServerPlugin.publicSites :: publicSites?: PublicSitesDeclaration
@/plugins/api :: member :: ServerPlugin.loginMethods :: loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]
@/plugins/api :: member :: ServerPlugin.ssoPolicy :: ssoPolicy?: SsoPolicy
@/plugins/api :: member :: ServerPlugin.apiPrefixes :: apiPrefixes?: readonly string[]
@/plugins/api :: member :: ServerPlugin.jobHandlers :: jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }
@/plugins/api :: member :: ServerPlugin.agents :: agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }
@/plugins/api :: member :: ServerPlugin.prompts :: prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }
@/plugins/api :: member :: ServerPlugin.agentTools :: agentTools?: (ctx: AgentToolContext) => Tool[] | Promise<Tool[]>
@/plugins/api :: member :: ServerPlugin.knowledgeSources :: knowledgeSources?: (scope: AccessScope) => readonly string[] | Promise<readonly string[]>
@/plugins/api :: member :: ServerPlugin.scheduledTasks :: scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
@/plugins/api :: member :: ServerPlugin.emailHandlers :: emailHandlers?: readonly EmailHandler[]
@/plugins/api :: member :: ServerPlugin.eventHandlers :: eventHandlers?: readonly EventHandler[]
@/plugins/api :: member :: ServerPlugin.deploymentFeatures :: deploymentFeatures?: (config: AppConfig) => readonly string[]
@/plugins/api :: member :: ServerPlugin.grants :: grants?: Partial<Record<EffectiveRole, RoleGrant>>
@/plugins/api :: member :: ServerPlugin.uploadPaths :: uploadPaths?: readonly string[]
@/plugins/api :: member :: ServerPlugin.rlsExcludedTables :: rlsExcludedTables?: readonly string[]
@/plugins/api :: member :: ServerPlugin.unscopedAllowlist :: unscopedAllowlist?: Readonly<Record<string, string>>
@/plugins/api :: member :: ServerPlugin.visibilityResources :: visibilityResources?: readonly VisibilityResource[]
@/plugins/api :: member :: ServerPlugin.hooks :: hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> onTenantStatusChanged?: ( db: Database, tenantId: string, status: 'active' | 'suspended', env: AppBindings ) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }
@/plugins/api :: member :: ServerPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/api :: interface :: SetResourceGroupsInput :: interface SetResourceGroupsInput
@/plugins/api :: function :: sharedWithMyGroups :: function sharedWithMyGroups( scope: AccessScope, junction: string, foreignKey: string, resourceId: SQL ): SQL
@/plugins/api :: interface :: SiftOptions :: interface SiftOptions<T>
@/plugins/api :: interface :: SiftResult :: interface SiftResult<T>
@/plugins/api :: function :: signState :: async function signState( config: PluginConfig, purpose: string, payload: Record<string, unknown>, opts: { ttlSeconds?: number } = {} ): Promise<string>
@/plugins/api :: type :: SpanKind :: type SpanKind = 'agent' | 'llm' | 'tool' | 'retrieval' | 'embedding' | 'job' | 'span'
@/plugins/api :: interface :: SpanParams :: interface SpanParams
@/plugins/api :: interface :: SsoRequirement :: interface SsoRequirement
@/plugins/api :: type :: StartAgentRun :: type StartAgentRun = (input: StartAgentRunInput) => Promise<StartedAgentRun>
@/plugins/api :: interface :: StartAgentRunInput :: interface StartAgentRunInput
@/plugins/api :: member :: StartAgentRunInput.agentKey :: agentKey: AgentKey
@/plugins/api :: member :: StartAgentRunInput.tenantId :: tenantId: string
@/plugins/api :: member :: StartAgentRunInput.input :: input: unknown
@/plugins/api :: member :: StartAgentRunInput.idempotencyKey :: idempotencyKey?: string
@/plugins/api :: member :: StartAgentRunInput.concurrencyKey :: concurrencyKey?: string
@/plugins/api :: member :: StartAgentRunInput.triggeredBy :: triggeredBy?: string | null
@/plugins/api :: interface :: StartedAgentRun :: interface StartedAgentRun
@/plugins/api :: member :: StartedAgentRun.runId :: runId: string
@/plugins/api :: member :: StartedAgentRun.status :: status: AgentRunStatus
@/plugins/api :: member :: StartedAgentRun.deduplicated :: deduplicated: boolean
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
@/plugins/api :: interface :: StorageService :: interface StorageService
@/plugins/api :: interface :: StoredObject :: interface StoredObject extends StoredObjectMeta
@/plugins/api :: interface :: StoredObjectMeta :: interface StoredObjectMeta
@/plugins/api :: function :: streamChat :: async function streamChat(c: AppContext, options: StreamChatOptions): Promise<Response>
@/plugins/api :: type :: StreamChatEmit :: type StreamChatEmit = (name: string, value: unknown) => Promise<void>
@/plugins/api :: interface :: StreamChatOptions :: interface StreamChatOptions
@/plugins/api :: interface :: StreamChatResult :: interface StreamChatResult
@/plugins/api :: interface :: StreamChatToolCtx :: interface StreamChatToolCtx extends ToolCtx
@/plugins/api :: member :: StreamChatToolCtx.emit :: emit: StreamChatEmit
@/plugins/api :: interface :: StreamChatTurn :: interface StreamChatTurn
@/plugins/api :: type :: Subjects :: type Subjects = CoreSubject | PluginSubject | FeatureSubject
@/plugins/api :: type :: Tenant :: type Tenant = typeof tenants.$inferSelect
@/plugins/api :: type :: TenantEmit :: type TenantEmit = <E extends EventName>( event: E, input: TenantEmitInput<E> ) => Promise<EmittedEvent>
@/plugins/api :: type :: TenantEmitInput :: type TenantEmitInput = Omit<EmitInput<E>, 'tenantId'>
@/plugins/api :: interface :: Tool :: interface Tool<Input = unknown>
@/plugins/api :: interface :: ToolApproval :: interface ToolApproval
@/plugins/api :: interface :: ToolCallParams :: interface ToolCallParams
@/plugins/api :: function :: toolCtx :: function toolCtx(ctx: AgentToolContext): ToolCtx
@/plugins/api :: interface :: ToolCtx :: interface ToolCtx
@/plugins/api :: member :: ToolCtx.db :: db: Database
@/plugins/api :: member :: ToolCtx.config :: config: PluginConfig
@/plugins/api :: member :: ToolCtx.env :: env: PluginBindings
@/plugins/api :: member :: ToolCtx.scope :: scope: AccessScope
@/plugins/api :: member :: ToolCtx.tenantId :: tenantId: string
@/plugins/api :: member :: ToolCtx.can :: can: AbilityCheck
@/plugins/api :: member :: ToolCtx.maxDocumentChars :: maxDocumentChars?: number
@/plugins/api :: member :: ToolCtx.requesterUrls :: requesterUrls: ReadonlySet<string>
@/plugins/api :: member :: ToolCtx.storage :: storage(): StorageService
@/plugins/api :: member :: ToolCtx.features :: features(): Promise<readonly string[]>
@/plugins/api :: function :: toolInputSchema :: function toolInputSchema(schema: ZodType): JsonSchema
@/plugins/api :: interface :: ToolLoopCheckpoint :: interface ToolLoopCheckpoint
@/plugins/api :: interface :: ToolLoopResult :: interface ToolLoopResult
@/plugins/api :: function :: traceChatClient :: function traceChatClient( client: ChatClient, trace: TraceHandle, meta: TraceClientMeta, tracer?: Tracer ): ChatClient
@/plugins/api :: interface :: TraceHandle :: interface TraceHandle
@/plugins/api :: interface :: Tracer :: interface Tracer
@/plugins/api :: function :: traceStep :: async function traceStep<T>( params: StepParams, fn: () => Promise<T>, describe?: (result: T) => StepOutcome ): Promise<T>
@/plugins/api :: function :: tracingEnabled :: function tracingEnabled(tracer: Tracer): boolean
@/plugins/api :: function :: transaction :: async function transaction<T>( db: PluginContext['db'], fn: (tx: PluginContext['db']) => Promise<T> ): Promise<T>
@/plugins/api :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api :: member :: UiPlugin.shared :: shared: S
@/plugins/api :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/api :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/api :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/api :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/api :: member :: UiPlugin.header :: header?: readonly PluginHeaderItem[]
@/plugins/api :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/api :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/plugins/api :: member :: UiPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/api :: function :: usageFeatureIssue :: function usageFeatureIssue(pluginId: string, feature: string): string | null
@/plugins/api :: type :: User :: type User = typeof users.$inferSelect
@/plugins/api :: function :: validate :: function validate<T extends ZodSchema, Target extends keyof ValidationTargets>( target: Target, schema: T )
@/plugins/api :: function :: verifyState :: async function verifyState<T = Record<string, unknown>>( config: PluginConfig, purpose: string, token: string ): Promise<T | null>
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
@/plugins/api/ui-wiring :: interface :: PluginHeaderItem :: interface PluginHeaderItem
@/plugins/api/ui-wiring :: type :: PluginHeaderPlacement :: type PluginHeaderPlacement = 'center' | 'end'
@/plugins/api/ui-wiring :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/api/ui-wiring :: member :: PluginNavGroup.label :: label?: string
@/plugins/api/ui-wiring :: member :: PluginNavGroup.before :: before?: string
@/plugins/api/ui-wiring :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/api/ui-wiring :: interface :: PluginRoute :: interface PluginRoute
@/plugins/api/ui-wiring :: member :: PluginRoute.path :: path: string
@/plugins/api/ui-wiring :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/api/ui-wiring :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/api/ui-wiring :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/api/ui-wiring :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public' | 'workspace'
@/plugins/api/ui-wiring :: interface :: QuickLink :: interface QuickLink
@/plugins/api/ui-wiring :: interface :: TabConfig :: interface TabConfig
@/plugins/api/ui-wiring :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/api/ui-wiring :: member :: UiPlugin.shared :: shared: S
@/plugins/api/ui-wiring :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/api/ui-wiring :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/api/ui-wiring :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/api/ui-wiring :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/api/ui-wiring :: member :: UiPlugin.header :: header?: readonly PluginHeaderItem[]
@/plugins/api/ui-wiring :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/api/ui-wiring :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/plugins/api/ui-wiring :: member :: UiPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/api/ui-wiring :: function :: useNavGuard :: function useNavGuard(): (guard: NavGuard | undefined) => boolean
@/plugins/api/ui :: function :: AccessBadge :: function AccessBadge({ visibility, groups, className = '', }: { visibility: ResourceVisibility groups: GroupRef[] className?: string })
@/plugins/api/ui :: function :: AccessPicker :: function AccessPicker({ visibility, groupIds, available, onChange, tenantName, disabled = false, idPrefix = 'access', }: AccessPickerProps)
@/plugins/api/ui :: interface :: AccessPickerProps :: interface AccessPickerProps
@/plugins/api/ui :: function :: AlertModal :: function AlertModal({ isOpen, title, message, type = 'info', onClose }: AlertModalProps)
@/plugins/api/ui :: const :: api :: const api: { get<T>(url: string, options?: ApiRequestOptions<T>): Promise<T>; post<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; put<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>): Promise<T>; patch<T>(url: string, body?: unknown, options?: ApiRequestOptions<T>):… (truncated)
@/plugins/api/ui :: class :: ApiError :: class ApiError extends Error
@/plugins/api/ui :: interface :: ApiRequestOptions :: interface ApiRequestOptions<T = unknown> extends Omit<RequestInit, 'body'>
@/plugins/api/ui :: interface :: Breadcrumb :: interface Breadcrumb
@/plugins/api/ui :: function :: Breadcrumbs :: function Breadcrumbs({ items, className = '', }: { items: Breadcrumb[] className?: string })
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
@/plugins/api/ui :: function :: MarkdownImageLink :: function MarkdownImageLink({ src, alt }: Pick<ComponentProps<'img'>, 'src' | 'alt'>)
@/plugins/api/ui :: function :: Modal :: function Modal({ open, onClose, title, children, actions, closeButton = true, className = '', }: ModalProps)
@/plugins/api/ui :: interface :: ModalProps :: interface ModalProps
@/plugins/api/ui :: type :: NavGuard :: type NavGuard = | 'admin' | 'globalAdmin' | { action: string; subject: string } | { feature: string } | readonly NavGuard[]
@/plugins/api/ui :: interface :: NavigationChecks :: interface NavigationChecks
@/plugins/api/ui :: function :: navigationEntries :: function navigationEntries( plugins: readonly AnyUiPlugin[], { canAccess, can }: NavigationChecks ): NavigationEntry[]
@/plugins/api/ui :: interface :: NavigationEntry :: interface NavigationEntry
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
@/plugins/api/ui :: function :: SideNav :: default function SideNav({ items = navigationConfig, footer, forceCollapsed, }: SideNavProps)
@/plugins/api/ui :: function :: SkeletonRows :: function SkeletonRows({ rows = 4, className = '' }: { rows?: number; className?: string })
@/plugins/api/ui :: interface :: TabConfig :: interface TabConfig
@/plugins/api/ui :: function :: timeAgo :: function timeAgo(value: Date | null | undefined, fallback = 'never'): string
@/plugins/api/ui :: interface :: Toast :: interface Toast
@/plugins/api/ui :: function :: ToastContainer :: function ToastContainer()
@/plugins/api/ui :: type :: ToastType :: type ToastType = 'success' | 'error' | 'warning' | 'info'
@/plugins/api/ui :: function :: uiExtensions :: function uiExtensions(key: string): readonly unknown[]
@/plugins/api/ui :: function :: uiExtensionSources :: function uiExtensionSources(key: string): readonly string[]
@/plugins/api/ui :: const :: UNLABELLED_NAV_GROUP :: const UNLABELLED_NAV_GROUP: "Pages"
@/plugins/api/ui :: function :: URLTabs :: function URLTabs({ tabs, defaultTab, param = 'tab', className = '', actions, }: URLTabsProps)
@/plugins/api/ui :: function :: useAuth :: function useAuth(): AuthContextValue
@/plugins/api/ui :: function :: useFeature :: function useFeature(name: FeatureName): boolean
@/plugins/api/ui :: function :: useGroups :: function useGroups(typeId?: string, enabled = true)
@/plugins/api/ui :: function :: useGroupTypes :: function useGroupTypes(enabled = true)
@/plugins/api/ui :: function :: useMyGroups :: function useMyGroups()
@/plugins/api/ui :: function :: useNavigationEntries :: function useNavigationEntries(): NavigationEntry[]
@/plugins/api/ui :: function :: usePermissions :: function usePermissions()
@/plugins/api/ui :: function :: useTenancyMode :: function useTenancyMode(): TenancyMode
@/plugins/api/ui :: const :: useToastStore :: const useToastStore: UseBoundStore<StoreApi<ToastStore>>
@/plugins/api/ui :: function :: VisibilityModal :: function VisibilityModal({ open, onClose, name, visibility, groups, available, tenantName, isSaving = false, onSave, }: VisibilityModalProps)
@/plugins/api/ui :: interface :: VisibilityModalProps :: interface VisibilityModalProps
@/plugins/types :: type :: AnyServerPlugin :: type AnyServerPlugin = ServerPlugin<SharedPlugin>
@/plugins/types :: type :: AnyUiPlugin :: type AnyUiPlugin = UiPlugin<SharedPlugin>
@/plugins/types :: interface :: PluginHeaderItem :: interface PluginHeaderItem
@/plugins/types :: type :: PluginHeaderPlacement :: type PluginHeaderPlacement = 'center' | 'end'
@/plugins/types :: type :: PluginMount :: type PluginMount = readonly [string, Hono<AppEnv>, MiddlewareHandler?]
@/plugins/types :: interface :: PluginNavGroup :: interface PluginNavGroup
@/plugins/types :: member :: PluginNavGroup.label :: label?: string
@/plugins/types :: member :: PluginNavGroup.before :: before?: string
@/plugins/types :: member :: PluginNavGroup.items :: items: NavItem[]
@/plugins/types :: type :: PluginPublicMount :: type PluginPublicMount = readonly [string, Hono<AppEnv>, PluginPublicMountOptions?]
@/plugins/types :: interface :: PluginPublicMountOptions :: interface PluginPublicMountOptions
@/plugins/types :: interface :: PluginRequires :: interface PluginRequires
@/plugins/types :: interface :: PluginRoute :: interface PluginRoute
@/plugins/types :: member :: PluginRoute.path :: path: string
@/plugins/types :: member :: PluginRoute.Component :: Component: LazyExoticComponent<ComponentType>
@/plugins/types :: member :: PluginRoute.guard :: guard?: NavGuard
@/plugins/types :: member :: PluginRoute.tier :: tier?: PluginRouteTier
@/plugins/types :: type :: PluginRouteTier :: type PluginRouteTier = 'shell' | 'noTenant' | 'public' | 'workspace'
@/plugins/types :: interface :: PluginSeedContext :: interface PluginSeedContext
@/plugins/types :: interface :: PublicSiteCsp :: interface PublicSiteCsp
@/plugins/types :: interface :: PublicSiteFormPath :: interface PublicSiteFormPath
@/plugins/types :: interface :: PublicSitesDeclaration :: interface PublicSitesDeclaration
@/plugins/types :: interface :: ServerPlugin :: interface ServerPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/types :: member :: ServerPlugin.shared :: shared: S
@/plugins/types :: member :: ServerPlugin.requires :: requires?: PluginRequires
@/plugins/types :: member :: ServerPlugin.mounts :: mounts?: readonly PluginMount[]
@/plugins/types :: member :: ServerPlugin.publicMounts :: publicMounts?: readonly PluginPublicMount[]
@/plugins/types :: member :: ServerPlugin.publicSites :: publicSites?: PublicSitesDeclaration
@/plugins/types :: member :: ServerPlugin.loginMethods :: loginMethods?: (cfg: AppConfig) => readonly PluginLoginMethodDeclaration[]
@/plugins/types :: member :: ServerPlugin.ssoPolicy :: ssoPolicy?: SsoPolicy
@/plugins/types :: member :: ServerPlugin.apiPrefixes :: apiPrefixes?: readonly string[]
@/plugins/types :: member :: ServerPlugin.jobHandlers :: jobHandlers?: { [T in JobTypeOf<S> & string]: JobHandler<Extract<T, JobType>> }
@/plugins/types :: member :: ServerPlugin.agents :: agents?: { [K in AgentKeyOf<S> & string]: AnyAgentDefinition }
@/plugins/types :: member :: ServerPlugin.prompts :: prompts?: { [K in PromptKeyOf<S> & string]: PromptDefinition }
@/plugins/types :: member :: ServerPlugin.agentTools :: agentTools?: (ctx: AgentToolContext) => Tool[] | Promise<Tool[]>
@/plugins/types :: member :: ServerPlugin.knowledgeSources :: knowledgeSources?: (scope: AccessScope) => readonly string[] | Promise<readonly string[]>
@/plugins/types :: member :: ServerPlugin.scheduledTasks :: scheduledTasks?: Readonly<Record<string, ScheduledTask[]>>
@/plugins/types :: member :: ServerPlugin.emailHandlers :: emailHandlers?: readonly EmailHandler[]
@/plugins/types :: member :: ServerPlugin.eventHandlers :: eventHandlers?: readonly EventHandler[]
@/plugins/types :: member :: ServerPlugin.deploymentFeatures :: deploymentFeatures?: (config: AppConfig) => readonly string[]
@/plugins/types :: member :: ServerPlugin.grants :: grants?: Partial<Record<EffectiveRole, RoleGrant>>
@/plugins/types :: member :: ServerPlugin.uploadPaths :: uploadPaths?: readonly string[]
@/plugins/types :: member :: ServerPlugin.rlsExcludedTables :: rlsExcludedTables?: readonly string[]
@/plugins/types :: member :: ServerPlugin.unscopedAllowlist :: unscopedAllowlist?: Readonly<Record<string, string>>
@/plugins/types :: member :: ServerPlugin.visibilityResources :: visibilityResources?: readonly VisibilityResource[]
@/plugins/types :: member :: ServerPlugin.hooks :: hooks?: { onTenantCreated?: ( db: Database, tenant: Tenant, userId: string, features: readonly string[] ) => Promise<void> onTenantDeleted?: (db: Database, tenantId: string, env: AppBindings) => Promise<void> onTenantStatusChanged?: ( db: Database, tenantId: string, status: 'active' | 'suspended', env: AppBindings ) => Promise<void> seedDemo?: (db: Database, ctx: PluginSeedContext) => Promise<void> }
@/plugins/types :: member :: ServerPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/plugins/types :: interface :: UiPlugin :: interface UiPlugin<S extends SharedPlugin = SharedPlugin>
@/plugins/types :: member :: UiPlugin.shared :: shared: S
@/plugins/types :: member :: UiPlugin.routes :: routes: readonly PluginRoute[]
@/plugins/types :: member :: UiPlugin.nav :: nav?: readonly PluginNavGroup[]
@/plugins/types :: member :: UiPlugin.settingsTabs :: settingsTabs?: (ctx: { can: (action: string, subject: string) => boolean }) => TabConfig[]
@/plugins/types :: member :: UiPlugin.homeLinks :: homeLinks?: readonly QuickLink[]
@/plugins/types :: member :: UiPlugin.header :: header?: readonly PluginHeaderItem[]
@/plugins/types :: member :: UiPlugin.queryKeys :: queryKeys?: Readonly<Record<string, unknown>>
@/plugins/types :: member :: UiPlugin.agentForms :: agentForms?: Readonly<Partial<Record<AgentKeyOf<S> & string, AgentForm>>>
@/plugins/types :: member :: UiPlugin.extensions :: extensions?: Readonly<Record<string, readonly unknown[]>>
@/db/schema/kit :: const :: activityEvents :: const activityEvents: table "activity_events" { id, tenantId, userId, type, subjectType, subjectId, metadata, createdAt }
@/db/schema/kit :: const :: groupMembers :: const groupMembers: table "group_members" { tenantId, groupId, userId, createdAt }
@/db/schema/kit :: const :: groups :: const groups: table "groups" { createdAt, updatedAt, id, tenantId, groupTypeId, name, description }
@/db/schema/kit :: const :: groupTypes :: const groupTypes: table "group_types" { createdAt, updatedAt, id, tenantId, name, description }
@/db/schema/kit :: function :: membershipIsolation :: function membershipIsolation()
@/db/schema/kit :: const :: RESOURCE_VISIBILITY_VALUES :: const RESOURCE_VISIBILITY_VALUES: readonly ["tenant", "groups"]
@/db/schema/kit :: function :: tenantIsolation :: function tenantIsolation(table: string, column = sql`tenant_id`)
@/db/schema/kit :: function :: tenantRef :: function tenantRef(tenants: { id: AnyPgColumn })
@/db/schema/kit :: const :: tenants :: const tenants: table "tenants" { createdAt, updatedAt, id, name, slug, status, externalOrgId, idpSyncedAt, seedDataCreated, lastAccessedAt }
@/db/schema/kit :: const :: tenantUsers :: const tenantUsers: table "tenant_users" { tenantId, userId, role, source, idpSyncedAt, joinedAt, invitedByUserId }
@/db/schema/kit :: function :: timestamps :: function timestamps()
@/db/schema/kit :: const :: users :: const users: table "users" { createdAt, updatedAt, id, email, name, avatarUrl, isGlobalAdmin, globalAdminSource, emailVerifiedAt, lastLoginAt, blockedAt, blockedSource }
@rocketflare/shared/plugins/api :: type :: Actions :: type Actions = (typeof ACTIONS)[number]
@rocketflare/shared/plugins/api :: type :: AgentKeyOf :: type AgentKeyOf = NonNullable<DeclaredBy<S, 'agentKeys'>>[number]
@rocketflare/shared/plugins/api :: type :: ApiErrorBody :: type ApiErrorBody = z.infer<typeof apiErrorSchema>
@rocketflare/shared/plugins/api :: const :: apiErrorSchema :: const apiErrorSchema: z.ZodObject<{ error: z.ZodString; statusCode: z.ZodNumber; code: z.ZodOptional<z.ZodString>; details: z.ZodOptional<z.ZodUnknown>; }, z.core.$strip>
@rocketflare/shared/plugins/api :: type :: DeclaredBy :: type DeclaredBy = Extract<P, Record<K, unknown>> extends infer Declaring ? Declaring extends Record<K, unknown> ? Declaring[K] : never : never
@rocketflare/shared/plugins/api :: const :: ERROR_CODES :: const ERROR_CODES: { readonly validationFailed: "validation_failed"; readonly unauthorized: "unauthorized"; readonly sessionExpired: "session_expired"; readonly forbidden: "forbidden"; readonly notFound: "not_found"; readonly conflict: "conflict"; readonly rateLimited: "rate_limited"; readonly pendingApproval: "pendin… (truncated)
@rocketflare/shared/plugins/api :: type :: ErrorCode :: type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
@rocketflare/shared/plugins/api :: const :: EVENT_NAME_RE :: const EVENT_NAME_RE: RegExp
@rocketflare/shared/plugins/api :: type :: EventNameOf :: type EventNameOf = Extract< EventsOf<S> extends infer R ? (R extends unknown ? keyof R : never) : never, string >
@rocketflare/shared/plugins/api :: function :: eventNameProblem :: function eventNameProblem(pluginId: string, name: string): string | null
@rocketflare/shared/plugins/api :: type :: EventPayloadOf :: type EventPayloadOf = E extends unknown ? EventsOf<S> extends infer R ? R extends Record<E, infer Schema> ? Schema extends ZodTypeAny ? TypeOf<Schema> : never : never : never : never
@rocketflare/shared/plugins/api :: type :: EventsOf :: type EventsOf = NonNullable<DeclaredBy<S, 'events'>>
@rocketflare/shared/plugins/api :: interface :: FeatureDefinition :: interface FeatureDefinition
@rocketflare/shared/plugins/api :: type :: FeatureFlagState :: type FeatureFlagState = z.infer<typeof featureFlagStateSchema>
@rocketflare/shared/plugins/api :: type :: FeatureKeyOf :: type FeatureKeyOf = Extract< NonNullable<DeclaredBy<S, 'features'>> extends infer F ? F extends unknown ? keyof F : never : never, string >
@rocketflare/shared/plugins/api :: type :: FeatureRolloutUnit :: type FeatureRolloutUnit = z.infer<typeof featureRolloutUnitSchema>
@rocketflare/shared/plugins/api :: type :: GroupRef :: type GroupRef = z.infer<typeof groupRefSchema>
@rocketflare/shared/plugins/api :: function :: isPluginId :: function isPluginId(value: string): boolean
@rocketflare/shared/plugins/api :: function :: isSameOriginPath :: function isSameOriginPath(value: string): boolean
@rocketflare/shared/plugins/api :: type :: JobInput :: type JobInput = z.infer<typeof jobInputSchema>
@rocketflare/shared/plugins/api :: type :: JobOf :: type JobOf = Extract<JobEnvelope, { type: T }>
@rocketflare/shared/plugins/api :: type :: JobType :: type JobType = JobEnvelope['type']
@rocketflare/shared/plugins/api :: type :: JobTypeOf :: type JobTypeOf = TypeOf< NonNullable<DeclaredBy<S, 'jobs'>>[number]['shape']['type'] >
@rocketflare/shared/plugins/api :: type :: JobVariant :: type JobVariant = ZodObject<{ type: ZodTypeAny } & ZodRawShape>
@rocketflare/shared/plugins/api :: type :: MembershipRole :: type MembershipRole = z.infer<typeof membershipRoleSchema>
@rocketflare/shared/plugins/api :: function :: paginatedResponse :: function paginatedResponse<T extends z.ZodTypeAny>(item: T)
@rocketflare/shared/plugins/api :: function :: paginationMeta :: function paginationMeta(page: number, pageSize: number, total: number): PaginationMeta
@rocketflare/shared/plugins/api :: type :: PaginationMeta :: type PaginationMeta = z.infer<typeof paginationMetaSchema>
@rocketflare/shared/plugins/api :: const :: paginationMetaSchema :: const paginationMetaSchema: z.ZodObject<{ page: z.ZodNumber; pageSize: z.ZodNumber; total: z.ZodNumber; totalPages: z.ZodNumber; }, z.core.$strip>
@rocketflare/shared/plugins/api :: type :: PaginationQuery :: type PaginationQuery = z.infer<typeof paginationQuerySchema>
@rocketflare/shared/plugins/api :: const :: paginationQuerySchema :: const paginationQuerySchema: z.ZodObject<{ page: z.ZodDefault<z.ZodCoercedNumber<unknown>>; pageSize: z.ZodDefault<z.ZodCoercedNumber<unknown>>; }, z.core.$strip>
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
@rocketflare/shared/plugins/api :: member :: SharedPlugin.events :: readonly events?: Readonly<Record<string, ZodTypeAny>>
@rocketflare/shared/plugins/api :: type :: SubjectOf :: type SubjectOf = NonNullable<DeclaredBy<S, 'subjects'>>[number]
@rocketflare/shared/plugins/api :: type :: Subjects :: type Subjects = CoreSubject | PluginSubject | FeatureSubject
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
'../api' (apps/cli/src/plugins/api.ts) :: function :: neutralise :: function neutralise(text: string): string
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
@testkit/integration :: function :: aguiFrames :: async function aguiFrames(res: Response): Promise<KitAguiEvent[]>
@testkit/integration :: function :: aguiTypes :: function aguiTypes(events: KitAguiEvent[]): string[]
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
@testkit/integration :: function :: customEvents :: function customEvents(events: KitAguiEvent[]): { name: string; value: unknown }[]
@testkit/integration :: function :: deliverEvents :: async function deliverEvents(env: TestEnv, db: Database): Promise<EventDelivery[]>
@testkit/integration :: function :: dispatchScheduled :: async function dispatchScheduled( cron: string, env: AppBindings, ctx: Pick<ExecutionContext, 'waitUntil'>, registry: Record<string, ScheduledTask[]> = SCHEDULED_TASKS ): Promise<TaskReport[]>
@testkit/integration :: function :: errorResponse :: function errorResponse(status: number, error = 'Error', code?: string)
@testkit/integration :: interface :: EventDelivery :: interface EventDelivery
@testkit/integration :: const :: IDS :: const IDS: { user: string; otherUser: string; tenant: string; otherTenant: string; }
@testkit/integration :: function :: json :: async function json<T = unknown>(res: Response): Promise<T>
@testkit/integration :: function :: jsonResponse :: function jsonResponse(body: unknown, status = 200)
@testkit/integration :: function :: linkUserToTenant :: async function linkUserToTenant( db: Database, userId: string, tenantId: string, role: MembershipRole = 'member', invitedByUserId: string | null = null )
@testkit/integration :: function :: makeSession :: function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse
@testkit/integration :: function :: makeTenant :: function makeTenant(overrides: Partial<TenantSummary> = {}): TenantSummary
@testkit/integration :: function :: makeUser :: function makeUser(overrides: Partial<User> = {}): User
@testkit/integration :: const :: notFoundResponse :: const notFoundResponse: () => Response
@testkit/integration :: function :: paged :: function paged<T>(items: T[], pageSize = 25)
@testkit/integration :: interface :: PlatformChatCall :: interface PlatformChatCall
@testkit/integration :: interface :: PlatformChatTurn :: interface PlatformChatTurn
@testkit/integration :: interface :: RecordedMessage :: interface RecordedMessage<T = unknown>
@testkit/integration :: function :: renderWithProviders :: function renderWithProviders( ui: ReactElement, { route = '/', queryClient = createTestQueryClient(), session, ...options }: ProviderOptions = {} )
@testkit/integration :: function :: request :: async function request( path: string, init: RequestInit = {}, options: RequestOptions = {} ): Promise<Response>
@testkit/integration :: function :: requestBody :: function requestBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>, key: string)
@testkit/integration :: interface :: RequestOptions :: interface RequestOptions
@testkit/integration :: type :: RouteTable :: type RouteTable = Record< string, Response | unknown | ((init: RequestInit | undefined, url: URL) => Response | unknown) >
@testkit/integration :: function :: rulesFor :: function rulesFor( role: MembershipRole | null, isGlobalAdmin = false, features: string[] = [] )
@testkit/integration :: const :: SCHEDULED_TASKS :: const SCHEDULED_TASKS: Record<string, ScheduledTask[]>
@testkit/integration :: interface :: ScheduledTask :: interface ScheduledTask
@testkit/integration :: function :: scriptPlatformChat :: function scriptPlatformChat( env: { AI?: unknown }, script: PlatformChatTurn[] | ((call: PlatformChatCall, index: number) => PlatformChatTurn) ): PlatformChatCall[]
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
@testkit/unit :: interface :: BackgroundCtxOptions :: interface BackgroundCtxOptions extends BaseOptions
@testkit/unit :: interface :: CronCtxOptions :: interface CronCtxOptions extends BackgroundCtxOptions
@testkit/unit :: type :: FakeCronCtx :: type FakeCronCtx = CronCtx & RecordsAgentRuns
@testkit/unit :: type :: FakeEmailCtx :: type FakeEmailCtx = EmailCtx & RecordsAgentRuns
@testkit/unit :: type :: FakeJobCtx :: type FakeJobCtx = JobCtx & RecordsAgentRuns
@testkit/unit :: type :: FakeRequestCtx :: type FakeRequestCtx = RequestCtx & { readonly deferred: ReadonlyArray<() => Promise<unknown>> settle(): Promise<void> }
@testkit/unit :: type :: FakeWorkflowCtx :: type FakeWorkflowCtx = WorkflowCtx & { readonly recorded: ReturnType<typeof createFakeWorkflowStep> }
@testkit/unit :: function :: makeCronCtx :: function makeCronCtx(options: CronCtxOptions): FakeCronCtx
@testkit/unit :: function :: makeEmailCtx :: function makeEmailCtx(options: CronCtxOptions): FakeEmailCtx
@testkit/unit :: function :: makeJobCtx :: function makeJobCtx(options: BackgroundCtxOptions): FakeJobCtx
@testkit/unit :: function :: makeRequestCtx :: function makeRequestCtx(options: RequestCtxOptions): FakeRequestCtx
@testkit/unit :: function :: makeToolCtx :: function makeToolCtx(options: ToolCtxOptions): ToolCtx
@testkit/unit :: function :: makeWorkflowCtx :: function makeWorkflowCtx(options: WorkflowCtxOptions): FakeWorkflowCtx
@testkit/unit :: interface :: RecordedAgentRun :: interface RecordedAgentRun
@testkit/unit :: interface :: RecordsAgentRuns :: interface RecordsAgentRuns
@testkit/unit :: interface :: RequestCtxOptions :: interface RequestCtxOptions extends BaseOptions
@testkit/unit :: interface :: ToolCtxOptions :: interface ToolCtxOptions extends BaseOptions
@testkit/unit :: interface :: WorkflowCtxOptions :: interface WorkflowCtxOptions extends BaseOptions
```
