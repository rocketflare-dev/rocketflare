# The plugin API

**Generated. Do not edit.** `node scripts/plugin-api-doc.mjs` writes this file and
`docs/plugin-surface.json` from the source of the declared entries, and the kit's CI
(`.github/workflows/kit.yml`) regenerates both and diffs them. **A diff failure means a file is
stale. Run the script and commit what it writes.**

This is the whole of what a plugin may import from the host. The rule the entries make true is one
sentence: **a plugin imports only from declared entries, and receives everything else as injected
context** (`apps/web/tests/helpers/plugins.ts` enforces it, and every diagnostic it prints carries
the replacement import). Anything not listed here is a kit internal: reaching for it is what makes a
plugin's own version number meaningless, because the plugin is then pinned to something nobody
promised to keep.

- **What to import for a job** — "handle a request", "enqueue a job", "prove tenant isolation" —
  is the index in `.claude/skills/rf-plugin/reference.md` ("What you want to do").
- **A member's signature** is in the entry barrel itself; each entry below names its file.
- **The machine-readable surface** is `docs/plugin-surface.json`. The ledger at the end of this
  file carries the same names, for plugin tooling that has not moved to the JSON yet.

## The entries

| Import | File | For |
|---|---|---|
| `@/plugins/api` | `apps/web/src/plugins/api/index.ts` | The server surface: the context family, and the types a plugin must be able to name. |
| `@/plugins/api/peers` | `apps/web/src/plugins/api/peers.ts` | The two escape hatches that read the whole installed set. Not on the barrel, on purpose. |
| `@/plugins/api/ui-wiring` | `apps/web/src/plugins/api/ui-wiring.ts` | The only host module a plugin's `ui/index.ts` may import — it ships in the main bundle. |
| `@/plugins/api/ui` | `apps/web/src/plugins/api/ui.ts` | Components and hooks, for a lazy PAGE. Never for the UI entry. |
| `@/plugins/types` | `apps/web/src/plugins/types.ts` | `ServerPlugin` and `UiPlugin` — the slots a plugin fills. |
| `@/db/schema/kit` | `apps/web/src/db/schema/kit.ts` | The build-time schema symbols. A `pgTable(...)` runs at module scope, so these cannot be injected. |
| `@rocketflare/shared/plugins/api` | `packages/shared/src/plugins/api.ts` | What a plugin's CONTRACT module imports: the error envelope, pagination, `SharedPlugin`. |
| `'../api' (apps/cli/src/plugins/api.ts)` | `apps/cli/src/plugins/api.ts` | The CLI half: the one `fetch` site, the exit codes, the output helpers. |
| `'./types' (apps/cli/src/plugins/types.ts)` | `apps/cli/src/plugins/types.ts` | `CliPlugin` and the `action()` wrapper it registers with. |
| `@testkit/integration` | `apps/web/tests/kit/integration.ts` | The harness: a real database, the real Hono app, real bindings-shaped stubs, the provider tree. |
| `@testkit/unit` | `apps/web/tests/kit/unit.ts` | Builders for the context family, for tests that never touch data. |

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

The same members as `docs/plugin-surface.json`, one line each, `entry :: kind :: name :: -`.
Kept for plugin tooling that reads this file rather than the JSON; it goes once that tooling has
moved (#182). The fourth field was a signature and is always `-` now.

```text
@/plugins/api :: type :: AbilityCheck :: -
@/plugins/api :: interface :: AccessScope :: -
@/plugins/api :: type :: Actions :: -
@/plugins/api :: interface :: ActivityInput :: -
@/plugins/api :: function :: affected :: -
@/plugins/api :: function :: agentCtx :: -
@/plugins/api :: interface :: AgentCtx :: -
@/plugins/api :: member :: AgentCtx.db :: -
@/plugins/api :: member :: AgentCtx.config :: -
@/plugins/api :: member :: AgentCtx.env :: -
@/plugins/api :: member :: AgentCtx.logger :: -
@/plugins/api :: member :: AgentCtx.tenantId :: -
@/plugins/api :: member :: AgentCtx.runId :: -
@/plugins/api :: member :: AgentCtx.userId :: -
@/plugins/api :: member :: AgentCtx.input :: -
@/plugins/api :: member :: AgentCtx.tools :: -
@/plugins/api :: member :: AgentCtx.storage :: -
@/plugins/api :: member :: AgentCtx.emit :: -
@/plugins/api :: member :: AgentCtx.prompt :: -
@/plugins/api :: member :: AgentCtx.step :: -
@/plugins/api :: member :: AgentCtx.checkCancelled :: -
@/plugins/api :: member :: AgentCtx.signal :: -
@/plugins/api :: member :: AgentCtx.once :: -
@/plugins/api :: member :: AgentCtx.spawn :: -
@/plugins/api :: member :: AgentCtx.toolLoop :: -
@/plugins/api :: member :: AgentCtx.structured :: -
@/plugins/api :: member :: AgentCtx.decide :: -
@/plugins/api :: member :: AgentCtx.interrupt :: -
@/plugins/api :: member :: AgentCtx.chatModel :: -
@/plugins/api :: interface :: AgentDecide :: -
@/plugins/api :: interface :: AgentEventBinding :: -
@/plugins/api :: interface :: AgentEventTrigger :: -
@/plugins/api :: interface :: AgentInterruptAnswer :: -
@/plugins/api :: interface :: AgentInterruptAsk :: -
@/plugins/api :: interface :: AgentSummary :: -
@/plugins/api :: interface :: AgentTraceContext :: -
@/plugins/api :: class :: AiNotConfiguredError :: -
@/plugins/api :: type :: AnyServerPlugin :: -
@/plugins/api :: function :: anyTermTsquery :: -
@/plugins/api :: type :: AnyUiPlugin :: -
@/plugins/api :: class :: ApiError :: -
@/plugins/api :: type :: AppRouter :: -
@/plugins/api :: interface :: BackgroundMethods :: -
@/plugins/api :: member :: BackgroundMethods.enqueue :: -
@/plugins/api :: member :: BackgroundMethods.enqueueMany :: -
@/plugins/api :: member :: BackgroundMethods.nudge :: -
@/plugins/api :: member :: BackgroundMethods.durableObject :: -
@/plugins/api :: member :: BackgroundMethods.features :: -
@/plugins/api :: member :: BackgroundMethods.storage :: -
@/plugins/api :: member :: BackgroundMethods.startAgentRun :: -
@/plugins/api :: member :: BackgroundMethods.emit :: -
@/plugins/api :: class :: BadRequestError :: -
@/plugins/api :: type :: BindableAgent :: -
@/plugins/api :: function :: candidatePoolSize :: -
@/plugins/api :: function :: chatModelAvailable :: -
@/plugins/api :: class :: ConflictError :: -
@/plugins/api :: function :: createRouter :: -
@/plugins/api :: function :: createStepRealtimeFor :: -
@/plugins/api :: function :: cronCtx :: -
@/plugins/api :: interface :: CronCtx :: -
@/plugins/api :: member :: CronCtx.kind :: -
@/plugins/api :: member :: CronCtx.waitUntil :: -
@/plugins/api :: function :: customEventNameIssue :: -
@/plugins/api :: type :: Database :: -
@/plugins/api :: interface :: DatabaseHandle :: -
@/plugins/api :: interface :: Decision :: -
@/plugins/api :: const :: DEFAULT_RESOLVE_MIN_SCORE :: -
@/plugins/api :: function :: defaultEntityResolver :: -
@/plugins/api :: function :: defineTool :: -
@/plugins/api :: function :: deleteIngestedDocument :: -
@/plugins/api :: interface :: DeliveredEvent :: -
@/plugins/api :: interface :: DetachedCtx :: -
@/plugins/api :: member :: DetachedCtx.tenantId :: -
@/plugins/api :: member :: DetachedCtx.userId :: -
@/plugins/api :: member :: DetachedCtx.role :: -
@/plugins/api :: member :: DetachedCtx.isAdmin :: -
@/plugins/api :: member :: DetachedCtx.features :: -
@/plugins/api :: member :: DetachedCtx.scope :: -
@/plugins/api :: member :: DetachedCtx.groups :: -
@/plugins/api :: class :: DuplicateStepNameError :: -
@/plugins/api :: function :: durableObject :: -
@/plugins/api :: const :: EMAIL_CATCH_ALL :: -
@/plugins/api :: type :: EmailContext :: -
@/plugins/api :: function :: emailCtx :: -
@/plugins/api :: interface :: EmailCtx :: -
@/plugins/api :: member :: EmailCtx.waitUntil :: -
@/plugins/api :: interface :: EmailHandler :: -
@/plugins/api :: function :: emailLocalPart :: -
@/plugins/api :: function :: emailSubaddress :: -
@/plugins/api :: type :: Emit :: -
@/plugins/api :: interface :: EmitInput :: -
@/plugins/api :: interface :: EmittedEvent :: -
@/plugins/api :: type :: EntityResolver :: -
@/plugins/api :: interface :: EntityResolveScope :: -
@/plugins/api :: interface :: EntityTypeRegistration :: -
@/plugins/api :: function :: eventBinding :: -
@/plugins/api :: interface :: EventContext :: -
@/plugins/api :: function :: eventCtx :: -
@/plugins/api :: interface :: EventCtx :: -
@/plugins/api :: member :: EventCtx.tenantId :: -
@/plugins/api :: member :: EventCtx.enqueue :: -
@/plugins/api :: member :: EventCtx.enqueueMany :: -
@/plugins/api :: member :: EventCtx.nudge :: -
@/plugins/api :: member :: EventCtx.emit :: -
@/plugins/api :: member :: EventCtx.features :: -
@/plugins/api :: member :: EventCtx.storage :: -
@/plugins/api :: member :: EventCtx.durableObject :: -
@/plugins/api :: member :: EventCtx.startAgentRun :: -
@/plugins/api :: member :: EventCtx.startBoundAgent :: -
@/plugins/api :: interface :: EventHandler :: -
@/plugins/api :: type :: EventName :: -
@/plugins/api :: type :: EventPayload :: -
@/plugins/api :: function :: eventTrigger :: -
@/plugins/api :: class :: ForbiddenError :: -
@/plugins/api :: function :: fuseByRank :: -
@/plugins/api :: interface :: FusedItem :: -
@/plugins/api :: function :: hasFeature :: -
@/plugins/api :: interface :: HookCtx :: -
@/plugins/api :: member :: HookCtx.tenant :: -
@/plugins/api :: member :: HookCtx.tenantId :: -
@/plugins/api :: member :: HookCtx.userId :: -
@/plugins/api :: member :: HookCtx.features :: -
@/plugins/api :: function :: identityFor :: -
@/plugins/api :: type :: IdpAppRole :: -
@/plugins/api :: function :: ingestDocument :: -
@/plugins/api :: function :: ingestDocumentFile :: -
@/plugins/api :: function :: ingestPlatformDocument :: -
@/plugins/api :: class :: InvalidCustomEventError :: -
@/plugins/api :: function :: isAdminLevel :: -
@/plugins/api :: function :: isApiError :: -
@/plugins/api :: function :: isGlobalAdmin :: -
@/plugins/api :: function :: isOwnerLevel :: -
@/plugins/api :: function :: isUniqueViolation :: -
@/plugins/api :: function :: jobCtx :: -
@/plugins/api :: interface :: JobCtx :: -
@/plugins/api :: member :: JobCtx.kind :: -
@/plugins/api :: type :: JobEnvelope :: -
@/plugins/api :: type :: JobHandler :: -
@/plugins/api :: type :: JobInput :: -
@/plugins/api :: type :: JobOf :: -
@/plugins/api :: type :: JobType :: -
@/plugins/api :: function :: listAgents :: -
@/plugins/api :: function :: listBindableAgents :: -
@/plugins/api :: type :: Logger :: -
@/plugins/api :: interface :: McpToolAnnotations :: -
@/plugins/api :: type :: McpToolScope :: -
@/plugins/api :: function :: memberCan :: -
@/plugins/api :: type :: MembershipRole :: -
@/plugins/api :: const :: noopTracer :: -
@/plugins/api :: class :: NotFoundError :: -
@/plugins/api :: function :: notify :: -
@/plugins/api :: interface :: NotifyInput :: -
@/plugins/api :: function :: notifyMany :: -
@/plugins/api :: function :: nudge :: -
@/plugins/api :: function :: nudgeEntity :: -
@/plugins/api :: function :: nudgeUser :: -
@/plugins/api :: function :: nudgeUsers :: -
@/plugins/api :: function :: openSecret :: -
@/plugins/api :: function :: pageWindow :: -
@/plugins/api :: function :: pgErrorCode :: -
@/plugins/api :: interface :: PickOptions :: -
@/plugins/api :: interface :: PickResult :: -
@/plugins/api :: interface :: PlatformDocumentInput :: -
@/plugins/api :: interface :: PlatformDocumentResult :: -
@/plugins/api :: class :: PlatformEmbeddingsError :: -
@/plugins/api :: type :: PluginAgent :: -
@/plugins/api :: interface :: PluginAuth :: -
@/plugins/api :: member :: PluginAuth.user :: -
@/plugins/api :: member :: PluginAuth.userId :: -
@/plugins/api :: member :: PluginAuth.apiKeyId :: -
@/plugins/api :: member :: PluginAuth.tenantId :: -
@/plugins/api :: member :: PluginAuth.role :: -
@/plugins/api :: member :: PluginAuth.isAdmin :: -
@/plugins/api :: member :: PluginAuth.isOwner :: -
@/plugins/api :: member :: PluginAuth.isGlobalAdmin :: -
@/plugins/api :: member :: PluginAuth.features :: -
@/plugins/api :: type :: PluginBindings :: -
@/plugins/api :: type :: PluginConfig :: -
@/plugins/api :: interface :: PluginConfirmedUpload :: -
@/plugins/api :: interface :: PluginContext :: -
@/plugins/api :: member :: PluginContext.db :: -
@/plugins/api :: member :: PluginContext.config :: -
@/plugins/api :: member :: PluginContext.logger :: -
@/plugins/api :: member :: PluginContext.env :: -
@/plugins/api :: interface :: PluginDeprovisionResult :: -
@/plugins/api :: interface :: PluginHeaderItem :: -
@/plugins/api :: type :: PluginHeaderPlacement :: -
@/plugins/api :: interface :: PluginHomeCard :: -
@/plugins/api :: interface :: PluginIdentity :: -
@/plugins/api :: interface :: PluginIdentityUser :: -
@/plugins/api :: interface :: PluginIngestFileInput :: -
@/plugins/api :: interface :: PluginIngestResult :: -
@/plugins/api :: interface :: PluginIngestTextInput :: -
@/plugins/api :: type :: PluginLogger :: -
@/plugins/api :: interface :: PluginLoginMethodDeclaration :: -
@/plugins/api :: interface :: PluginMember :: -
@/plugins/api :: type :: PluginMount :: -
@/plugins/api :: interface :: PluginNavGroup :: -
@/plugins/api :: member :: PluginNavGroup.label :: -
@/plugins/api :: member :: PluginNavGroup.before :: -
@/plugins/api :: member :: PluginNavGroup.items :: -
@/plugins/api :: interface :: PluginProvision :: -
@/plugins/api :: type :: PluginPublicMount :: -
@/plugins/api :: interface :: PluginPublicMountOptions :: -
@/plugins/api :: interface :: PluginRequires :: -
@/plugins/api :: interface :: PluginRoute :: -
@/plugins/api :: member :: PluginRoute.path :: -
@/plugins/api :: member :: PluginRoute.Component :: -
@/plugins/api :: member :: PluginRoute.guard :: -
@/plugins/api :: member :: PluginRoute.tier :: -
@/plugins/api :: type :: PluginRouteTier :: -
@/plugins/api :: interface :: PluginSeedContext :: -
@/plugins/api :: interface :: PluginSettingsTab :: -
@/plugins/api :: interface :: PluginSignInInput :: -
@/plugins/api :: type :: PluginStructuredOptions :: -
@/plugins/api :: type :: PluginToolLoopOptions :: -
@/plugins/api :: interface :: PluginUploadPrepared :: -
@/plugins/api :: interface :: PluginUploadPrepareInput :: -
@/plugins/api :: interface :: PluginUploadTarget :: -
@/plugins/api :: function :: provisionFor :: -
@/plugins/api :: function :: prunePlatformDocuments :: -
@/plugins/api :: const :: PUBLIC_MOUNT_ROOT :: -
@/plugins/api :: const :: PUBLIC_SITE_PAGE_CSP_HEADER :: -
@/plugins/api :: function :: publicCtx :: -
@/plugins/api :: interface :: PublicCtx :: -
@/plugins/api :: member :: PublicCtx.appUrl :: -
@/plugins/api :: member :: PublicCtx.defer :: -
@/plugins/api :: member :: PublicCtx.notFound :: -
@/plugins/api :: member :: PublicCtx.badRequest :: -
@/plugins/api :: member :: PublicCtx.forbidden :: -
@/plugins/api :: member :: PublicCtx.unauthorized :: -
@/plugins/api :: interface :: PublicSiteCsp :: -
@/plugins/api :: interface :: PublicSiteFormPath :: -
@/plugins/api :: interface :: PublicSitesDeclaration :: -
@/plugins/api :: class :: RateLimitedError :: -
@/plugins/api :: interface :: Realtime :: -
@/plugins/api :: function :: realtimeEvent :: -
@/plugins/api :: function :: recordActivity :: -
@/plugins/api :: function :: recordUsage :: -
@/plugins/api :: function :: requestCtx :: -
@/plugins/api :: interface :: RequestCtx :: -
@/plugins/api :: member :: RequestCtx.scope :: -
@/plugins/api :: member :: RequestCtx.groups :: -
@/plugins/api :: member :: RequestCtx.visibility :: -
@/plugins/api :: member :: RequestCtx.guard :: -
@/plugins/api :: member :: RequestCtx.can :: -
@/plugins/api :: member :: RequestCtx.hasFeature :: -
@/plugins/api :: member :: RequestCtx.uuid :: -
@/plugins/api :: member :: RequestCtx.valid :: -
@/plugins/api :: member :: RequestCtx.page :: -
@/plugins/api :: member :: RequestCtx.embeddable :: -
@/plugins/api :: member :: RequestCtx.defer :: -
@/plugins/api :: member :: RequestCtx.enqueue :: -
@/plugins/api :: member :: RequestCtx.enqueueMany :: -
@/plugins/api :: member :: RequestCtx.nudge :: -
@/plugins/api :: member :: RequestCtx.storage :: -
@/plugins/api :: member :: RequestCtx.emit :: -
@/plugins/api :: member :: RequestCtx.durableObject :: -
@/plugins/api :: member :: RequestCtx.notFound :: -
@/plugins/api :: member :: RequestCtx.badRequest :: -
@/plugins/api :: member :: RequestCtx.forbidden :: -
@/plugins/api :: member :: RequestCtx.unauthorized :: -
@/plugins/api :: member :: RequestCtx.conflict :: -
@/plugins/api :: member :: RequestCtx.unavailable :: -
@/plugins/api :: member :: RequestCtx.detached :: -
@/plugins/api :: member :: RequestCtx.realtime :: -
@/plugins/api :: interface :: RequestVisibility :: -
@/plugins/api :: member :: RequestVisibility.resolve :: -
@/plugins/api :: member :: RequestVisibility.set :: -
@/plugins/api :: member :: RequestVisibility.grantsFor :: -
@/plugins/api :: function :: requireFeature :: -
@/plugins/api :: function :: resolveOwnerTenant :: -
@/plugins/api :: interface :: ResourceGrantRow :: -
@/plugins/api :: function :: rows :: -
@/plugins/api :: interface :: ScheduledTask :: -
@/plugins/api :: function :: sealSecret :: -
@/plugins/api :: function :: searchKnowledge :: -
@/plugins/api :: interface :: SearchKnowledgeHit :: -
@/plugins/api :: interface :: SearchKnowledgeInput :: -
@/plugins/api :: interface :: SearchKnowledgeResult :: -
@/plugins/api :: interface :: SeedCtx :: -
@/plugins/api :: member :: SeedCtx.tenantId :: -
@/plugins/api :: member :: SeedCtx.ownerId :: -
@/plugins/api :: member :: SeedCtx.demoId :: -
@/plugins/api :: member :: SeedCtx.log :: -
@/plugins/api :: member :: SeedCtx.setFeature :: -
@/plugins/api :: interface :: ServerPlugin :: -
@/plugins/api :: member :: ServerPlugin.shared :: -
@/plugins/api :: member :: ServerPlugin.requires :: -
@/plugins/api :: member :: ServerPlugin.mounts :: -
@/plugins/api :: member :: ServerPlugin.publicMounts :: -
@/plugins/api :: member :: ServerPlugin.publicSites :: -
@/plugins/api :: member :: ServerPlugin.loginMethods :: -
@/plugins/api :: member :: ServerPlugin.ssoPolicy :: -
@/plugins/api :: member :: ServerPlugin.apiPrefixes :: -
@/plugins/api :: member :: ServerPlugin.jobHandlers :: -
@/plugins/api :: member :: ServerPlugin.agents :: -
@/plugins/api :: member :: ServerPlugin.prompts :: -
@/plugins/api :: member :: ServerPlugin.tools :: -
@/plugins/api :: member :: ServerPlugin.agentTools :: -
@/plugins/api :: member :: ServerPlugin.knowledgeSources :: -
@/plugins/api :: member :: ServerPlugin.knowledgeEntityTypes :: -
@/plugins/api :: member :: ServerPlugin.scheduledTasks :: -
@/plugins/api :: member :: ServerPlugin.emailHandlers :: -
@/plugins/api :: member :: ServerPlugin.eventHandlers :: -
@/plugins/api :: member :: ServerPlugin.deploymentFeatures :: -
@/plugins/api :: member :: ServerPlugin.grants :: -
@/plugins/api :: member :: ServerPlugin.uploadTargets :: -
@/plugins/api :: member :: ServerPlugin.uploadPaths :: -
@/plugins/api :: member :: ServerPlugin.uploadLimits :: -
@/plugins/api :: member :: ServerPlugin.rlsExcludedTables :: -
@/plugins/api :: member :: ServerPlugin.unscopedAllowlist :: -
@/plugins/api :: member :: ServerPlugin.visibilityResources :: -
@/plugins/api :: member :: ServerPlugin.hooks :: -
@/plugins/api :: member :: ServerPlugin.extensions :: -
@/plugins/api :: class :: ServiceUnavailableError :: -
@/plugins/api :: interface :: SetResourceGroupsInput :: -
@/plugins/api :: function :: sharedWithMyGroups :: -
@/plugins/api :: interface :: SiftOptions :: -
@/plugins/api :: interface :: SiftResult :: -
@/plugins/api :: function :: signState :: -
@/plugins/api :: type :: SpanKind :: -
@/plugins/api :: interface :: SpanParams :: -
@/plugins/api :: interface :: SsoRequirement :: -
@/plugins/api :: type :: StartAgentRun :: -
@/plugins/api :: interface :: StartAgentRunInput :: -
@/plugins/api :: member :: StartAgentRunInput.agentKey :: -
@/plugins/api :: member :: StartAgentRunInput.tenantId :: -
@/plugins/api :: member :: StartAgentRunInput.input :: -
@/plugins/api :: member :: StartAgentRunInput.idempotencyKey :: -
@/plugins/api :: member :: StartAgentRunInput.concurrencyKey :: -
@/plugins/api :: member :: StartAgentRunInput.triggeredBy :: -
@/plugins/api :: interface :: StartedAgentRun :: -
@/plugins/api :: member :: StartedAgentRun.runId :: -
@/plugins/api :: member :: StartedAgentRun.status :: -
@/plugins/api :: member :: StartedAgentRun.deduplicated :: -
@/plugins/api :: interface :: StepCtx :: -
@/plugins/api :: member :: StepCtx.name :: -
@/plugins/api :: member :: StepCtx.realtime :: -
@/plugins/api :: interface :: StepOptions :: -
@/plugins/api :: member :: StepOptions.retries :: -
@/plugins/api :: member :: StepOptions.timeout :: -
@/plugins/api :: interface :: StepRealtime :: -
@/plugins/api :: member :: StepRealtime.realtime :: -
@/plugins/api :: member :: StepRealtime.settle :: -
@/plugins/api :: member :: StepRealtime.nudgeEntity :: -
@/plugins/api :: member :: StepRealtime.send :: -
@/plugins/api :: member :: StepRealtime.sendToUser :: -
@/plugins/api :: member :: StepRealtime.sendToUsers :: -
@/plugins/api :: interface :: StorageService :: -
@/plugins/api :: interface :: StoredObject :: -
@/plugins/api :: interface :: StoredObjectMeta :: -
@/plugins/api :: function :: streamChat :: -
@/plugins/api :: type :: StreamChatEmit :: -
@/plugins/api :: interface :: StreamChatOptions :: -
@/plugins/api :: interface :: StreamChatResult :: -
@/plugins/api :: interface :: StreamChatToolCtx :: -
@/plugins/api :: member :: StreamChatToolCtx.emit :: -
@/plugins/api :: interface :: StreamChatTurn :: -
@/plugins/api :: type :: Subjects :: -
@/plugins/api :: type :: Tenant :: -
@/plugins/api :: type :: TenantEmit :: -
@/plugins/api :: type :: TenantEmitInput :: -
@/plugins/api :: interface :: Tool :: -
@/plugins/api :: interface :: ToolApproval :: -
@/plugins/api :: interface :: ToolCallParams :: -
@/plugins/api :: function :: toolCtx :: -
@/plugins/api :: interface :: ToolCtx :: -
@/plugins/api :: member :: ToolCtx.db :: -
@/plugins/api :: member :: ToolCtx.config :: -
@/plugins/api :: member :: ToolCtx.env :: -
@/plugins/api :: member :: ToolCtx.scope :: -
@/plugins/api :: member :: ToolCtx.tenantId :: -
@/plugins/api :: member :: ToolCtx.can :: -
@/plugins/api :: member :: ToolCtx.maxDocumentChars :: -
@/plugins/api :: member :: ToolCtx.requesterUrls :: -
@/plugins/api :: member :: ToolCtx.storage :: -
@/plugins/api :: member :: ToolCtx.features :: -
@/plugins/api :: member :: ToolCtx.requester :: -
@/plugins/api :: function :: toolInputSchema :: -
@/plugins/api :: interface :: ToolLoopCheckpoint :: -
@/plugins/api :: interface :: ToolLoopResult :: -
@/plugins/api :: interface :: ToolMcpOptions :: -
@/plugins/api :: interface :: ToolRequester :: -
@/plugins/api :: type :: ToolSurface :: -
@/plugins/api :: function :: traceChatClient :: -
@/plugins/api :: interface :: TraceHandle :: -
@/plugins/api :: interface :: Tracer :: -
@/plugins/api :: function :: traceStep :: -
@/plugins/api :: function :: tracingEnabled :: -
@/plugins/api :: function :: transaction :: -
@/plugins/api :: interface :: UiPlugin :: -
@/plugins/api :: member :: UiPlugin.shared :: -
@/plugins/api :: member :: UiPlugin.routes :: -
@/plugins/api :: member :: UiPlugin.nav :: -
@/plugins/api :: member :: UiPlugin.settingsTabs :: -
@/plugins/api :: member :: UiPlugin.homeLinks :: -
@/plugins/api :: member :: UiPlugin.homeCards :: -
@/plugins/api :: member :: UiPlugin.header :: -
@/plugins/api :: member :: UiPlugin.queryKeys :: -
@/plugins/api :: member :: UiPlugin.agentForms :: -
@/plugins/api :: member :: UiPlugin.extensions :: -
@/plugins/api :: class :: UnauthorizedError :: -
@/plugins/api :: function :: usageFeatureIssue :: -
@/plugins/api :: type :: User :: -
@/plugins/api :: function :: validate :: -
@/plugins/api :: function :: verifyState :: -
@/plugins/api :: interface :: VisibilityResource :: -
@/plugins/api :: function :: withAgentTrace :: -
@/plugins/api :: function :: workflowCtx :: -
@/plugins/api :: interface :: WorkflowCtx :: -
@/plugins/api :: member :: WorkflowCtx.config :: -
@/plugins/api :: member :: WorkflowCtx.env :: -
@/plugins/api :: member :: WorkflowCtx.logger :: -
@/plugins/api :: member :: WorkflowCtx.step :: -
@/plugins/api :: member :: WorkflowCtx.waitForEvent :: -
@/plugins/api/peers :: function :: allTables :: -
@/plugins/api/peers :: type :: AllTables :: -
@/plugins/api/peers :: function :: extensions :: -
@/plugins/api/peers :: function :: extensionSources :: -
@/plugins/api/ui-wiring :: type :: AnyUiPlugin :: -
@/plugins/api/ui-wiring :: const :: featureGuard :: -
@/plugins/api/ui-wiring :: const :: isGuardList :: -
@/plugins/api/ui-wiring :: type :: NavConfig :: -
@/plugins/api/ui-wiring :: interface :: NavGroup :: -
@/plugins/api/ui-wiring :: type :: NavGuard :: -
@/plugins/api/ui-wiring :: interface :: NavItem :: -
@/plugins/api/ui-wiring :: interface :: PluginHeaderItem :: -
@/plugins/api/ui-wiring :: type :: PluginHeaderPlacement :: -
@/plugins/api/ui-wiring :: interface :: PluginHomeCard :: -
@/plugins/api/ui-wiring :: interface :: PluginNavGroup :: -
@/plugins/api/ui-wiring :: member :: PluginNavGroup.label :: -
@/plugins/api/ui-wiring :: member :: PluginNavGroup.before :: -
@/plugins/api/ui-wiring :: member :: PluginNavGroup.items :: -
@/plugins/api/ui-wiring :: interface :: PluginRoute :: -
@/plugins/api/ui-wiring :: member :: PluginRoute.path :: -
@/plugins/api/ui-wiring :: member :: PluginRoute.Component :: -
@/plugins/api/ui-wiring :: member :: PluginRoute.guard :: -
@/plugins/api/ui-wiring :: member :: PluginRoute.tier :: -
@/plugins/api/ui-wiring :: type :: PluginRouteTier :: -
@/plugins/api/ui-wiring :: interface :: PluginSettingsTab :: -
@/plugins/api/ui-wiring :: interface :: QuickLink :: -
@/plugins/api/ui-wiring :: interface :: TabConfig :: -
@/plugins/api/ui-wiring :: interface :: UiPlugin :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.shared :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.routes :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.nav :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.settingsTabs :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.homeLinks :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.homeCards :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.header :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.queryKeys :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.agentForms :: -
@/plugins/api/ui-wiring :: member :: UiPlugin.extensions :: -
@/plugins/api/ui-wiring :: function :: useNavGuard :: -
@/plugins/api/ui :: function :: AccessBadge :: -
@/plugins/api/ui :: function :: AccessPicker :: -
@/plugins/api/ui :: interface :: AccessPickerProps :: -
@/plugins/api/ui :: function :: AlertModal :: -
@/plugins/api/ui :: const :: api :: -
@/plugins/api/ui :: class :: ApiError :: -
@/plugins/api/ui :: interface :: ApiRequestOptions :: -
@/plugins/api/ui :: interface :: Breadcrumb :: -
@/plugins/api/ui :: function :: Breadcrumbs :: -
@/plugins/api/ui :: function :: ConfirmModal :: -
@/plugins/api/ui :: function :: DocumentCard :: -
@/plugins/api/ui :: interface :: DocumentCardProps :: -
@/plugins/api/ui :: function :: DocumentLink :: -
@/plugins/api/ui :: function :: documentLinkProps :: -
@/plugins/api/ui :: interface :: DocumentLinkProps :: -
@/plugins/api/ui :: function :: EmptyState :: -
@/plugins/api/ui :: function :: EmptyStateCard :: -
@/plugins/api/ui :: function :: FieldError :: -
@/plugins/api/ui :: function :: fieldErrorFor :: -
@/plugins/api/ui :: function :: formatBytes :: -
@/plugins/api/ui :: function :: formatDate :: -
@/plugins/api/ui :: function :: formatDateTime :: -
@/plugins/api/ui :: function :: formatDuration :: -
@/plugins/api/ui :: function :: initials :: -
@/plugins/api/ui :: function :: LoadingIndicator :: -
@/plugins/api/ui :: function :: LogoMark :: -
@/plugins/api/ui :: function :: MarkdownImageLink :: -
@/plugins/api/ui :: function :: Modal :: -
@/plugins/api/ui :: interface :: ModalProps :: -
@/plugins/api/ui :: type :: NavGuard :: -
@/plugins/api/ui :: interface :: NavigationChecks :: -
@/plugins/api/ui :: function :: navigationEntries :: -
@/plugins/api/ui :: interface :: NavigationEntry :: -
@/plugins/api/ui :: function :: notifyUnauthorized :: -
@/plugins/api/ui :: function :: PageHeader :: -
@/plugins/api/ui :: function :: PaginationControls :: -
@/plugins/api/ui :: function :: passagesLabel :: -
@/plugins/api/ui :: function :: Provenance :: -
@/plugins/api/ui :: function :: ProvenanceLink :: -
@/plugins/api/ui :: interface :: ProvenanceProps :: -
@/plugins/api/ui :: function :: ProvenanceQuote :: -
@/plugins/api/ui :: interface :: ProvenanceSource :: -
@/plugins/api/ui :: interface :: ProvenanceWork :: -
@/plugins/api/ui :: function :: SearchInput :: -
@/plugins/api/ui :: function :: SectionPanel :: -
@/plugins/api/ui :: function :: SectionPanelSkeleton :: -
@/plugins/api/ui :: function :: SettingInput :: -
@/plugins/api/ui :: function :: SettingRow :: -
@/plugins/api/ui :: function :: SettingToggle :: -
@/plugins/api/ui :: function :: setUnauthorizedHandler :: -
@/plugins/api/ui :: function :: showToast :: -
@/plugins/api/ui :: function :: SideNav :: -
@/plugins/api/ui :: function :: SkeletonRows :: -
@/plugins/api/ui :: function :: sourceFromCard :: -
@/plugins/api/ui :: function :: sourceFromCitation :: -
@/plugins/api/ui :: function :: sourceFromFact :: -
@/plugins/api/ui :: function :: sourceTypeIcon :: -
@/plugins/api/ui :: interface :: TabConfig :: -
@/plugins/api/ui :: function :: timeAgo :: -
@/plugins/api/ui :: interface :: Toast :: -
@/plugins/api/ui :: function :: ToastContainer :: -
@/plugins/api/ui :: type :: ToastType :: -
@/plugins/api/ui :: function :: uiExtensions :: -
@/plugins/api/ui :: function :: uiExtensionSources :: -
@/plugins/api/ui :: const :: UNLABELLED_NAV_GROUP :: -
@/plugins/api/ui :: function :: URLTabs :: -
@/plugins/api/ui :: function :: useAuth :: -
@/plugins/api/ui :: function :: useFeature :: -
@/plugins/api/ui :: function :: useGroups :: -
@/plugins/api/ui :: function :: useGroupTypes :: -
@/plugins/api/ui :: function :: useMyGroups :: -
@/plugins/api/ui :: function :: useNavigationEntries :: -
@/plugins/api/ui :: function :: usePermissions :: -
@/plugins/api/ui :: function :: useTenancyMode :: -
@/plugins/api/ui :: const :: useToastStore :: -
@/plugins/api/ui :: function :: VisibilityModal :: -
@/plugins/api/ui :: interface :: VisibilityModalProps :: -
@/plugins/types :: type :: AnyServerPlugin :: -
@/plugins/types :: type :: AnyUiPlugin :: -
@/plugins/types :: interface :: PluginHeaderItem :: -
@/plugins/types :: type :: PluginHeaderPlacement :: -
@/plugins/types :: interface :: PluginHomeCard :: -
@/plugins/types :: type :: PluginMount :: -
@/plugins/types :: interface :: PluginNavGroup :: -
@/plugins/types :: member :: PluginNavGroup.label :: -
@/plugins/types :: member :: PluginNavGroup.before :: -
@/plugins/types :: member :: PluginNavGroup.items :: -
@/plugins/types :: type :: PluginPublicMount :: -
@/plugins/types :: interface :: PluginPublicMountOptions :: -
@/plugins/types :: interface :: PluginRequires :: -
@/plugins/types :: interface :: PluginRoute :: -
@/plugins/types :: member :: PluginRoute.path :: -
@/plugins/types :: member :: PluginRoute.Component :: -
@/plugins/types :: member :: PluginRoute.guard :: -
@/plugins/types :: member :: PluginRoute.tier :: -
@/plugins/types :: type :: PluginRouteTier :: -
@/plugins/types :: interface :: PluginSeedContext :: -
@/plugins/types :: interface :: PluginSettingsTab :: -
@/plugins/types :: interface :: PublicSiteCsp :: -
@/plugins/types :: interface :: PublicSiteFormPath :: -
@/plugins/types :: interface :: PublicSitesDeclaration :: -
@/plugins/types :: interface :: ServerPlugin :: -
@/plugins/types :: member :: ServerPlugin.shared :: -
@/plugins/types :: member :: ServerPlugin.requires :: -
@/plugins/types :: member :: ServerPlugin.mounts :: -
@/plugins/types :: member :: ServerPlugin.publicMounts :: -
@/plugins/types :: member :: ServerPlugin.publicSites :: -
@/plugins/types :: member :: ServerPlugin.loginMethods :: -
@/plugins/types :: member :: ServerPlugin.ssoPolicy :: -
@/plugins/types :: member :: ServerPlugin.apiPrefixes :: -
@/plugins/types :: member :: ServerPlugin.jobHandlers :: -
@/plugins/types :: member :: ServerPlugin.agents :: -
@/plugins/types :: member :: ServerPlugin.prompts :: -
@/plugins/types :: member :: ServerPlugin.tools :: -
@/plugins/types :: member :: ServerPlugin.agentTools :: -
@/plugins/types :: member :: ServerPlugin.knowledgeSources :: -
@/plugins/types :: member :: ServerPlugin.knowledgeEntityTypes :: -
@/plugins/types :: member :: ServerPlugin.scheduledTasks :: -
@/plugins/types :: member :: ServerPlugin.emailHandlers :: -
@/plugins/types :: member :: ServerPlugin.eventHandlers :: -
@/plugins/types :: member :: ServerPlugin.deploymentFeatures :: -
@/plugins/types :: member :: ServerPlugin.grants :: -
@/plugins/types :: member :: ServerPlugin.uploadTargets :: -
@/plugins/types :: member :: ServerPlugin.uploadPaths :: -
@/plugins/types :: member :: ServerPlugin.uploadLimits :: -
@/plugins/types :: member :: ServerPlugin.rlsExcludedTables :: -
@/plugins/types :: member :: ServerPlugin.unscopedAllowlist :: -
@/plugins/types :: member :: ServerPlugin.visibilityResources :: -
@/plugins/types :: member :: ServerPlugin.hooks :: -
@/plugins/types :: member :: ServerPlugin.extensions :: -
@/plugins/types :: interface :: UiPlugin :: -
@/plugins/types :: member :: UiPlugin.shared :: -
@/plugins/types :: member :: UiPlugin.routes :: -
@/plugins/types :: member :: UiPlugin.nav :: -
@/plugins/types :: member :: UiPlugin.settingsTabs :: -
@/plugins/types :: member :: UiPlugin.homeLinks :: -
@/plugins/types :: member :: UiPlugin.homeCards :: -
@/plugins/types :: member :: UiPlugin.header :: -
@/plugins/types :: member :: UiPlugin.queryKeys :: -
@/plugins/types :: member :: UiPlugin.agentForms :: -
@/plugins/types :: member :: UiPlugin.extensions :: -
@/db/schema/kit :: const :: activityEvents :: -
@/db/schema/kit :: const :: groupMembers :: -
@/db/schema/kit :: const :: groups :: -
@/db/schema/kit :: const :: groupTypes :: -
@/db/schema/kit :: function :: membershipIsolation :: -
@/db/schema/kit :: const :: RESOURCE_VISIBILITY_VALUES :: -
@/db/schema/kit :: function :: tenantIsolation :: -
@/db/schema/kit :: function :: tenantRef :: -
@/db/schema/kit :: const :: tenants :: -
@/db/schema/kit :: const :: tenantUsers :: -
@/db/schema/kit :: function :: timestamps :: -
@/db/schema/kit :: const :: users :: -
@rocketflare/shared/plugins/api :: type :: Actions :: -
@rocketflare/shared/plugins/api :: type :: AgentKeyOf :: -
@rocketflare/shared/plugins/api :: type :: ApiErrorBody :: -
@rocketflare/shared/plugins/api :: const :: apiErrorSchema :: -
@rocketflare/shared/plugins/api :: type :: DeclaredBy :: -
@rocketflare/shared/plugins/api :: const :: ERROR_CODES :: -
@rocketflare/shared/plugins/api :: type :: ErrorCode :: -
@rocketflare/shared/plugins/api :: const :: EVENT_NAME_RE :: -
@rocketflare/shared/plugins/api :: type :: EventNameOf :: -
@rocketflare/shared/plugins/api :: function :: eventNameProblem :: -
@rocketflare/shared/plugins/api :: type :: EventPayloadOf :: -
@rocketflare/shared/plugins/api :: type :: EventsOf :: -
@rocketflare/shared/plugins/api :: interface :: FeatureDefinition :: -
@rocketflare/shared/plugins/api :: type :: FeatureFlagState :: -
@rocketflare/shared/plugins/api :: type :: FeatureKeyOf :: -
@rocketflare/shared/plugins/api :: type :: FeatureRolloutUnit :: -
@rocketflare/shared/plugins/api :: type :: GroupRef :: -
@rocketflare/shared/plugins/api :: function :: isPluginId :: -
@rocketflare/shared/plugins/api :: function :: isSameOriginPath :: -
@rocketflare/shared/plugins/api :: type :: JobInput :: -
@rocketflare/shared/plugins/api :: type :: JobOf :: -
@rocketflare/shared/plugins/api :: type :: JobType :: -
@rocketflare/shared/plugins/api :: type :: JobTypeOf :: -
@rocketflare/shared/plugins/api :: type :: JobVariant :: -
@rocketflare/shared/plugins/api :: type :: MembershipRole :: -
@rocketflare/shared/plugins/api :: function :: paginatedResponse :: -
@rocketflare/shared/plugins/api :: function :: paginationMeta :: -
@rocketflare/shared/plugins/api :: type :: PaginationMeta :: -
@rocketflare/shared/plugins/api :: const :: paginationMetaSchema :: -
@rocketflare/shared/plugins/api :: type :: PaginationQuery :: -
@rocketflare/shared/plugins/api :: const :: paginationQuerySchema :: -
@rocketflare/shared/plugins/api :: const :: PLUGIN_ID_RE :: -
@rocketflare/shared/plugins/api :: function :: pluginNamespace :: -
@rocketflare/shared/plugins/api :: type :: PromptKeyOf :: -
@rocketflare/shared/plugins/api :: type :: RealtimeEvent :: -
@rocketflare/shared/plugins/api :: type :: RealtimeEventType :: -
@rocketflare/shared/plugins/api :: type :: ResourceVisibility :: -
@rocketflare/shared/plugins/api :: interface :: SharedPlugin :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.id :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.label :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.version :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.agentKeys :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.promptKeys :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.jobs :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.subjects :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.features :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.config :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.realtimeRoots :: -
@rocketflare/shared/plugins/api :: member :: SharedPlugin.events :: -
@rocketflare/shared/plugins/api :: type :: SubjectOf :: -
@rocketflare/shared/plugins/api :: type :: Subjects :: -
'../api' (apps/cli/src/plugins/api.ts) :: type :: ActionWrapper :: -
'../api' (apps/cli/src/plugins/api.ts) :: type :: AnyCliPlugin :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ApiClient :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ApiResponse :: -
'../api' (apps/cli/src/plugins/api.ts) :: class :: CliApiError :: -
'../api' (apps/cli/src/plugins/api.ts) :: class :: CliError :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: CliPlugin :: -
'../api' (apps/cli/src/plugins/api.ts) :: member :: CliPlugin.shared :: -
'../api' (apps/cli/src/plugins/api.ts) :: member :: CliPlugin.register :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: Column :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: CommandContext :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: ContextOptions :: -
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_ERROR :: -
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_FORBIDDEN :: -
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_NOT_LOGGED_IN :: -
'../api' (apps/cli/src/plugins/api.ts) :: const :: EXIT_OK :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: exitCodeForStatus :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatCell :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatDate :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatJson :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: formatPagination :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: neutralise :: -
'../api' (apps/cli/src/plugins/api.ts) :: class :: NotLoggedInError :: -
'../api' (apps/cli/src/plugins/api.ts) :: type :: OpenLike :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: Output :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: publicClient :: -
'../api' (apps/cli/src/plugins/api.ts) :: type :: QueryValue :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: renderTable :: -
'../api' (apps/cli/src/plugins/api.ts) :: interface :: RequestOptions :: -
'../api' (apps/cli/src/plugins/api.ts) :: function :: requireClient :: -
'./types' (apps/cli/src/plugins/types.ts) :: type :: ActionWrapper :: -
'./types' (apps/cli/src/plugins/types.ts) :: type :: AnyCliPlugin :: -
'./types' (apps/cli/src/plugins/types.ts) :: interface :: CliPlugin :: -
'./types' (apps/cli/src/plugins/types.ts) :: member :: CliPlugin.shared :: -
'./types' (apps/cli/src/plugins/types.ts) :: member :: CliPlugin.register :: -
@testkit/integration :: function :: aguiFrames :: -
@testkit/integration :: function :: aguiTypes :: -
@testkit/integration :: function :: bearerHeader :: -
@testkit/integration :: function :: callMcpTool :: -
@testkit/integration :: function :: cleanDatabase :: -
@testkit/integration :: function :: connectMcp :: -
@testkit/integration :: function :: createExecutionContext :: -
@testkit/integration :: function :: createTestApiKey :: -
@testkit/integration :: function :: createTestEnv :: -
@testkit/integration :: function :: createTestGlobalAdmin :: -
@testkit/integration :: function :: createTestQueryClient :: -
@testkit/integration :: function :: createTestSession :: -
@testkit/integration :: function :: createTestTenant :: -
@testkit/integration :: function :: createTestTenantWithUser :: -
@testkit/integration :: function :: createTestUser :: -
@testkit/integration :: function :: customEvents :: -
@testkit/integration :: function :: deliverEvents :: -
@testkit/integration :: function :: dispatchScheduled :: -
@testkit/integration :: function :: enableMcp :: -
@testkit/integration :: function :: errorResponse :: -
@testkit/integration :: interface :: EventDelivery :: -
@testkit/integration :: const :: IDS :: -
@testkit/integration :: function :: json :: -
@testkit/integration :: function :: jsonResponse :: -
@testkit/integration :: function :: linkUserToTenant :: -
@testkit/integration :: function :: makeSession :: -
@testkit/integration :: function :: makeTenant :: -
@testkit/integration :: function :: makeUser :: -
@testkit/integration :: function :: mcpClient :: -
@testkit/integration :: function :: mcpTestEnv :: -
@testkit/integration :: interface :: McpToolCallResult :: -
@testkit/integration :: const :: notFoundResponse :: -
@testkit/integration :: function :: paged :: -
@testkit/integration :: interface :: PlatformChatCall :: -
@testkit/integration :: interface :: PlatformChatTurn :: -
@testkit/integration :: interface :: RecordedMessage :: -
@testkit/integration :: function :: renderWithProviders :: -
@testkit/integration :: function :: request :: -
@testkit/integration :: function :: requestBody :: -
@testkit/integration :: interface :: RequestOptions :: -
@testkit/integration :: type :: RouteTable :: -
@testkit/integration :: function :: rulesFor :: -
@testkit/integration :: const :: SCHEDULED_TASKS :: -
@testkit/integration :: interface :: ScheduledTask :: -
@testkit/integration :: function :: scriptPlatformChat :: -
@testkit/integration :: const :: SESSION_COOKIE_NAME :: -
@testkit/integration :: function :: sessionCookieHeader :: -
@testkit/integration :: function :: setupTestDatabase :: -
@testkit/integration :: function :: stubFetch :: -
@testkit/integration :: function :: stubHealthFetch :: -
@testkit/integration :: function :: stubs :: -
@testkit/integration :: function :: stubSessionFetch :: -
@testkit/integration :: interface :: TaskReport :: -
@testkit/integration :: function :: testDatabaseUrl :: -
@testkit/integration :: type :: TestEnv :: -
@testkit/integration :: interface :: TestMcpConnection :: -
@testkit/integration :: interface :: TestSeed :: -
@testkit/integration :: function :: toolJson :: -
@testkit/integration :: const :: unauthorizedResponse :: -
@testkit/integration :: function :: uniqueId :: -
@testkit/integration :: function :: waitOnExecutionContext :: -
@testkit/unit :: interface :: BackgroundCtxOptions :: -
@testkit/unit :: interface :: CronCtxOptions :: -
@testkit/unit :: function :: expectOwnContributions :: -
@testkit/unit :: type :: FakeCronCtx :: -
@testkit/unit :: type :: FakeEmailCtx :: -
@testkit/unit :: type :: FakeJobCtx :: -
@testkit/unit :: type :: FakeRequestCtx :: -
@testkit/unit :: type :: FakeWorkflowCtx :: -
@testkit/unit :: function :: isOwnContribution :: -
@testkit/unit :: function :: makeCronCtx :: -
@testkit/unit :: function :: makeEmailCtx :: -
@testkit/unit :: function :: makeJobCtx :: -
@testkit/unit :: function :: makeRequestCtx :: -
@testkit/unit :: function :: makeToolCtx :: -
@testkit/unit :: function :: makeWorkflowCtx :: -
@testkit/unit :: function :: ownContributions :: -
@testkit/unit :: interface :: RecordedAgentRun :: -
@testkit/unit :: interface :: RecordsAgentRuns :: -
@testkit/unit :: interface :: RequestCtxOptions :: -
@testkit/unit :: interface :: ToolCtxOptions :: -
@testkit/unit :: interface :: WorkflowCtxOptions :: -
```
