# Connectors — Microsoft 365 and Google Workspace (D34)

This is the design for **organisation connections** to Microsoft 365 and Google Workspace:
directory, calendars, and later mail and files, synced into a Rocketflare tenant. The design was
researched in September 2026 against the vendors' live docs; the URLs are in §13. The rules that
stay true after it ships go in `docs/CONCEPTS.md` §17. Plugin mechanics are in §16 and
`docs/plugin-api.md`.

Status: **phase 0** (kit seams) and **phase 1** (the `connectors` base plugin plus the `m365`
provider, covering directory and calendar by polling) are being built. Phases 2–5 are designed here
and not built.

## 1. Logging in is not connecting

The kit already signs people in with Google and Microsoft through arctic (§2). Login asks for
`openid email profile` (plus `User.Read` for Microsoft) on the `common` authority. It stores one
`oauth_providers` row per **user**, never refreshes it, and reads nothing beyond who the person is.
Nothing described here changes login.

A **connection** is a different grant with a different subject:

| | Login (§2) | Connection (D34) |
|---|---|---|
| Who grants it | the person signing in | an **org admin** (Entra Global Admin / Privileged Role Admin; Workspace super admin), then optionally each user |
| What it reaches | the signer's own profile | every mailbox, calendar and drive in the organisation, or a scoped subset |
| Token | none kept in use | app-only token per customer tenant (M365), a JWT per impersonated user (Google), or a rotating refresh token per user (delegated) |
| The app behind it | the kit's `GOOGLE_*` / `MICROSOFT_*` login clients | a **separate operator-registered app** with its own permissions, verification and review |
| Where it lives | the kit's core auth | the `connectors` plugin plus one provider plugin each |

**Keep the two apps separate, including in production.** A login client that also asks for
`Mail.Read` makes every sign-in a consent prompt for mail, and one leaked secret would open both.
Separate apps also let verification (publisher verification on Microsoft, CASA on Google) move at
its own pace without holding up login.

## 2. Usage models

Three models are supported, and every customer ends up in one of them:

1. **Org-wide, app-only.** The admin consents once. Rocketflare reads every in-scope user's data
   with application permissions (Graph) or domain-wide delegation (Google). No user does anything.
2. **Admin-configured, per-user delegated.** The admin approves the app for the organisation
   (pre-consent or trust). Then each user who wants it clicks *Connect my account*, and the
   provider enforces that user's own permissions.
3. **Hybrid.** The directory and calendars sync org-wide. Mail and files are opt-in per user.

| | Org-wide app-only | Admin-configured + per-user | Hybrid |
|---|---|---|---|
| Setup | one admin action | one admin action, then a click from every user | both |
| Data scope | everything, or scoped (Exchange RBAC for Applications; Google has only per-OU service toggles) | only users who opted in | org-wide for directory and calendar, opt-in for mail and files |
| Trust | highest scrutiny: the admin grants read on all mail | least surprise for employees | mixed |
| Microsoft consent | admin consent to application permissions | since the 2025–26 default consent policy, user consent to Mail, Calendars, Files and Sites is **blocked** for third-party apps, so admin pre-consent (`prompt=admin_consent`) or the admin consent workflow is required | both |
| Google verification | domain-wide delegation has no consent screen; CASA status is **unresolved** (§13) | restricted scopes (`gmail.readonly`, `drive.readonly`) need verification plus CASA, **unless** the customer admin marks the client *Trusted* | both |
| Tokens | simple: client credentials per customer tenant (about an hour, cached), or a signed JWT per user; no refresh tokens | hard: a sealed refresh token per user, rotation (Microsoft issues a new one on every use), revocation, re-auth UX | both paths |
| Webhooks | any mailbox, operator-driven | `/me` only, tied to the user's token (`reauthorizationRequired`) | both |

**Decision: the hybrid data model from day one, with org-wide app-only shipped first.** Every row
already says who owns it, so adding per-user delegated connections in phase 4 is new code and no
migration of meaning.

### Data model

```
connectors_installations   one per (tenant, provider): the admin act
  provider, externalTenantId (Entra tenant guid | Google customer id + primary domain),
  appMode operator|byo, byoClientId, byoSecretEnc, grantedScopes, status
  pending|active|error|revoked, installedBy, lastError

connectors_connections     one per subject that data is read AS
  installationId, ownerType tenant|user, ownerUserId (null when tenant-owned),
  authKind app_only|dwd|delegated, subject (Graph object id / Google primary email; null for
  tenant-level directory), refreshTokenEnc (delegated only), scopes, status
  active|reauth_required|revoked
  unique (installationId, ownerType, subject)

connectors_sync_cursors    one per (connection, resource)
  resource directory:users|directory:groups|calendar:<id>|mail:<folder>|drive:<id>,
  cursor (deltaLink | historyId | syncToken | pageToken), claimedUntil, lastRunAt, lastError

connectors_push_channels   phase 2: Graph subscription id | Google channel id + resourceId,
  resource, expiresAt, renewAfter, secretHash (hash of clientState / channel token)

connectors_directory_users / _groups / _group_members, connectors_calendar_events   phase 1 data
```

- An org-wide install creates **one tenant-owned connection per mailbox**, discovered by the
  directory sync. A per-user connect (phase 4) creates a **user-owned** connection.
- If both exist for one subject, the **tenant-owned connection syncs** and the **user-owned one
  acts** (writes, drafts, and anything that should show the user's own name).
- `appMode: 'byo'` stores a customer's own app credentials, sealed, on the installation. It's the
  escape hatch for a regulated customer, and on Google a customer-owned *Internal* app sidesteps
  verification entirely.

## 3. Intra-tenant visibility — the rule

**Org-wide sync puts every employee's data into one kit tenant, so `tenantId` isolation is
necessary but no longer sufficient.** Without an owner on every row, a member's chat retrieves a
colleague's email. So:

- Every synced row carries `ownerUserId`, the kit user matched from the directory by
  `lower(email)`. If no kit user matches, the owner is null, and only admins can see the row until a
  match appears.
- Members read **only their own** events, mail and files. Owners and admins read everything, and
  the Connections page says so in words before the admin consents.
- Anything ingested into knowledge (phase 3) goes through `ingestDocument` with `ownerUserId`,
  `visibility: 'groups'` and `groupIds: []`. Under D29 that means **owner and admins only**, the same
  semantics chat's `search_knowledge` already honours through `AccessScope`. Shared files may widen
  this to the groups mapped from their provider ACL (a later refinement, §12).
- The rule is a test, not a convention. Each provider ships an "a member cannot read another
  member's rows" test beside its tenant-isolation test.

## 4. Package shape

- **Kit seams (phase 0).** Four small additions to `@/plugins/api` (the plan's appendix is the
  contract):
  1. `ServerPlugin.publicMounts` under `/api/hooks/<plugin id>`, mounted with no `authMiddleware`,
     with a `publicCtx(c)` adapter. This is for consent callbacks and webhooks. It sits under `/api`,
     so `run_worker_first` already covers it.
  2. `signState` / `verifyState`: purpose-bound HMAC state with an expiry, keyed from
     `OAUTH_ENCRYPTION_KEY`. A consent round-trip binds the tenant and user without a cookie.
  3. `ingestDocument` / `ingestDocumentFile` / `deleteIngestedDocument`, with an
     `(tenant_id, source, external_id)` upsert. This is how a re-sync replaces a document rather
     than duplicating it.
  4. `features(tenantId)` on `JobCtx` / `CronCtx` / `PublicCtx`, so a cron can skip a tenant whose
     flag is off.
- **`connectors` base plugin.** It owns the tables in §2, the `/api/connectors` routes, the
  public callback `/api/hooks/connectors/:provider/callback`, the Settings → *Connections* tab, the
  `connectors.sync` job, the cron, claims and cursors, the `rocketflare connectors` CLI, and the
  `connectors` feature flag.
- **Provider plugins** `m365` and `google-workspace`. Each declares
  `requires.plugins: ['connectors']` and contributes one entry to
  `extensions.connectorProviders`. The base plugin narrows those entries with zod (D31 decision 6):

  ```ts
  { id: 'm365', label, setupSteps,            // rendered on the Connections page
    beginInstall(ctx) → { redirectUrl } | { form },  // consent URL (state signed) or DWD form
    completeInstall(ctx, params) → installation patch,
    getToken(installation, subject?) → bearer,
    syncers: { directory, calendar, … } }      // each (ctx, connection, cursor) → { cursor, more }
  ```

  The base plugin never names a vendor. A third provider (Slack, Salesforce, Atlassian) is another
  entry in the same registry.

## 5. Operator setup — Microsoft 365

This is done **once per Rocketflare deployment**, by whoever runs the deployment.

1. **Register the app.** In the Entra admin centre go to *App registrations → New*. Choose
   *Accounts in any organizational directory* (multi-tenant). Use a name customers will recognise;
   they see it on the consent screen.
2. **Redirect URI** (Web): `<APP_URL>/api/hooks/connectors/m365/callback`, one per environment.
   For local development add `http://localhost:3001/api/hooks/connectors/m365/callback`.
3. **Credential.**
   - *Phase 1:* a client secret (at most 24 months) in `M365_CLIENT_ID` / `M365_CLIENT_SECRET` via
     `pnpm provision secrets <env>`. Diary the expiry.
   - *Follow-up:* a certificate. The JWT client assertion (current docs: PS256 with an `x5t#S256`
     header; RS256 with `x5t` is the legacy form) is signed in WebCrypto
     (`importKey('pkcs8', …, RSA-PSS)`), with the PEM kept as a Worker secret. There's nothing to
     rotate every two years.
4. **API permissions (Application)**, added in phases. Customers re-consent when the set grows:

   | Phase | Application permissions |
   |---|---|
   | 1 | `User.Read.All`, `Group.Read.All`, `Calendars.Read` |
   | 2 | none new (subscriptions use the same permissions) |
   | 3 | `Mail.Read` (or `Mail.ReadBasic`), `Files.Read.All`, `Sites.Read.All` (or `Sites.Selected`) |
   | 4 | *Delegated:* `openid offline_access User.Read Mail.Read Calendars.Read Files.Read.All` |

5. **Publisher verification before selling.** You need a Microsoft AI Cloud Partner Program
   account, a publisher domain that isn't `*.onmicrosoft.com`, and a DNS-verified domain matching
   the partner email. It's free and takes minutes once the partner account is verified. Unverified
   multi-tenant apps show a warning, and user consent to them may be blocked. Admins can still
   consent, which is enough for phase 1 pilots.
6. *(Optional, phase 3)* A **second registration without `Mail.Read`**, for customers who want to
   scope mail with Exchange RBAC for Applications. See §7 and §13 Q3.

## 6. Operator setup — Google Workspace

This is also done **once per deployment**. Create the project now: Google's quota changes of
1 May 2026 treat projects that already existed more kindly.

1. **GCP project**, dedicated to connectors. Enable the Admin SDK, Calendar, Gmail, Drive and
   Pub/Sub APIs.
2. **A service account.** One serves every customer domain; no project is needed per customer.
   Note its **numeric client id**, because customers paste that id into their Admin console.
3. **Credential**, choose one:
   - **A JSON key** as a Worker secret (`GOOGLE_WORKSPACE_SA_KEY`). The RS256 JWT is signed with
     WebCrypto `importKey('pkcs8', …, RSASSA-PKCS1-v1_5/SHA-256)`. Your own org policy
     `iam.disableServiceAccountKeyCreation` may forbid this. The customer's policy is irrelevant,
     because the service account lives in your project.
   - **Keyless (Workload Identity Federation).** The Worker signs its own OIDC JWT, and a WIF
     provider trusts that JWT's uploaded JWKS (up to 8 keys, so no public issuer is needed). Then
     `sts.googleapis.com` exchange → `iamcredentials…:signJwt` for the service account with the
     `sub` and `scope` claims → `oauth2.googleapis.com/token`. That's three round-trips, so cache
     the result. Each step is documented, but no end-to-end sample exists (§13 Q5).
4. *(Phase 2)* **Pub/Sub for Gmail push.** Create one topic, grant
   `gmail-api-push@system.gserviceaccount.com` publisher on it, and add one push subscription to
   `<APP_URL>/api/hooks/google-workspace/gmail` with **OIDC auth** (a push service account and an
   audience). One topic serves every customer; the payload names the mailbox.
5. *(Phase 4)* **An OAuth web client** for per-user connections:
   - Redirect `<APP_URL>/api/hooks/connectors/google-workspace/callback`.
   - Brand verification, then **publish to production**. A client left in *Testing* issues refresh
     tokens that die after 7 days.
6. *(Before GA of phase 3)* **Restricted-scope verification plus CASA** for `gmail.readonly` and
   `drive.readonly`. CASA is annual (ADA CASA v2.1.1, AL1 or AL2). Budget for it even for the
   domain-wide delegation path (§13 Q1).
7. *(Later)* **A Marketplace SDK listing.** An admin-installed Marketplace app grants the service
   account its scopes on install, which turns §8 into a single click.

## 7. Customer-admin setup — Microsoft 365

1. In Rocketflare, **Settings → Connections → Connect Microsoft 365**, signed in as an owner or
   admin.
2. Sign in to Microsoft as a Global Administrator or Privileged Role Administrator, read the
   permission list, and **Accept**. That's all.
   - The consent URL is `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=…&scope=https://graph.microsoft.com/.default&redirect_uri=…&state=<signState>`.
   - The callback receives `tenant=<guid>&admin_consent=True`. `verifyState` recovers the kit
     tenant and the user who started it.
3. *(Optional, phase 3: scoped mail.)* Run the generated **RBAC for Applications** script:
   `New-ServicePrincipal`, then `New-ManagementScope` (or an Administrative Unit), then
   `New-ManagementRoleAssignment -Role "Application Mail.Read"`, then
   `Test-ServicePrincipalAuthorization`. Remove the tenant-wide Entra `Mail.Read` grant, because
   the Entra grant and the Exchange scope are **unioned**. Changes take 30 minutes to 2 hours to
   apply.

**Automated from there:**
- tenant capture;
- client-credentials token minting and caching;
- the first directory sync, with one tenant-owned connection per mailbox;
- delta sync on the cron;
- detecting revoked consent (`AADSTS7000229` / `65001` at the token endpoint, or 401/403 from
  Graph → installation `error`, surfaced on the page);
- re-consent when the permission set grows (the page shows *Re-consent required*).

## 8. Customer-admin setup — Google Workspace

1. **Settings → Connections → Connect Google Workspace.** Rocketflare shows the service account's
   **client id** and the **exact scope list** for the enabled phases, each with a copy button.
2. As a **super admin**, in the Admin console, go to *Security → Access and data control → API
   controls → Manage Domain Wide Delegation → Add new*. Paste both and click **Authorize**.
   Propagation can take up to 24 hours, and multi-party approval may apply.
3. Back in Rocketflare, enter the **primary domain** and an **admin email** to impersonate for
   Directory calls, then click **Test connection**. It tries the token exchange **per scope** and
   reports each missing one (`unauthorized_client`) by name, so a partial paste is obvious.
4. *(Phase 4, per-user mode without verification.)* Go to *Security → API controls → App access
   control* and mark the OAuth client **Trusted**.

**Automated:** user enumeration, per-user `sub` impersonation, calendar sync, and, from phase 2,
channel creation, renewal and Gmail `users.watch`.

## 9. Sync model

- **Incremental cursors, never timestamps:**

  | Resource | Microsoft Graph | Google |
  |---|---|---|
  | Users | `users/delta` | Directory `users.list`; `users.watch` from phase 2 |
  | Groups | `groups/delta` (`members@delta`) | `groups.list` + `members.list` |
  | Calendar | `/users/{id}/calendarView/delta?startDateTime&endDateTime` over a rolling window (−30 d … +90 d) | `events.list` with `syncToken`, parameters identical every time |
  | Mail | `/users/{id}/mailFolders/{id}/messages/delta`, per folder | `history.list(startHistoryId)` |
  | Files | `/drives/{id}/root/delta` | `changes.getStartPageToken` → `changes.list` with `includeItemsFromAllDrives` |

  To "start from now" without a backfill, use `$deltatoken=latest` for the directory and
  `token=latest` for drives.
- **One job shape.** `connectors.sync {tenantId, connectionId, resource}`:
  1. **Claims** the cursor row (`claimedUntil = now() + lease`, conditional update). If the claim
     fails, some other run owns the cursor and the job acknowledges. Concurrency is a DB claim row,
     never a `Map`.
  2. Fetches **one page**, upserts idempotently (both vendors replay), and persists the cursor.
  3. Re-enqueues itself while there are more pages, so a backfill is a chain of short jobs rather
     than one long request.
  4. Throws to retry, returns to acknowledge.
- **Cron `*/15 * * * *`.** For every active installation of every tenant with `connectors` on
  (`ctx.features(tenantId)`), it enqueues the cursors that are due. Phase 2 drops calendar and mail
  to a slow backstop cadence, because webhooks become the trigger.
- **Full-resync triggers:**
  - Graph `410 Gone` or `syncStateNotFound`. Outlook delta tokens have no fixed lifetime, and
    directory tokens last about 7 days.
  - Google `410` (calendar sync token) or `404` (Gmail `historyId` too old).
  - Graph `missed` / `subscriptionRemoved` lifecycle events.
  - An admin clicking *Resync*.

  A resync clears the cursor, re-lists everything, and marks rows not seen as deleted.
- **Throttling:**
  - Honour `Retry-After` by re-enqueuing with `delaySeconds`, never by sleeping in the Worker.
  - Graph: send `x-ms-throttle-priority: low` on background calls. Outlook allows 4 concurrent
    requests and 10,000 per 10 minutes per app per mailbox, so claims serialise per mailbox.
  - Google: per-user quotas apply; with domain-wide delegation, set `quotaUser` to the subject.
- **Deletion and revocation.** Removing an installation revokes what can be revoked, deletes the
  connections, cursors and channels, and purges the synced rows. `recordActivity` logs the act, and
  the secrets are never logged.

## 10. Webhooks — phase 2, on the public mount seam

Both providers drop notifications. **A webhook only nudges; polling stays the backstop.** Every
handler does the same three things: verify, enqueue `connectors.sync` for the affected cursor, and
return **202** in under 3 seconds. No sync work runs in the request.

**Microsoft Graph** at `/api/hooks/connectors/m365/notify` and `/api/hooks/connectors/m365/lifecycle`:

- **Handshake.** `?validationToken=…` must be echoed back URL-decoded, as `200 text/plain`, within
  10 seconds. This applies to both URLs.
- **`clientState`.** Use a random value per subscription (up to 128 characters), store only its
  hash in `connectors_push_channels.secretHash`, and compare in constant time on every
  notification. On a mismatch, answer 202 and drop the notification.
- **Lifetimes and renewal.** Outlook mail and events last at most 10,080 minutes (under 7 days),
  drive items 42,300 minutes, users and groups 41,760 minutes. A renewal cron `PATCH`es each
  subscription at about half its lifetime.
- **Lifecycle events.** On `reauthorizationRequired`, call `POST /subscriptions/{id}/reauthorize`
  (or `PATCH`, but not both within 10 minutes). On `missed` or `subscriptionRemoved`, recreate the
  subscription and resync.
- **Scale.** Outlook subscriptions are **per mailbox**, so N users means about 2N subscriptions.
  Key each one on the user's object id, not the UPN.
- **Rich notifications** (encrypted resource data) are **not used**. Basic notification plus a
  delta fetch is simpler, and needs no certificate or 1-day lifetime.
- **Slow endpoints are punished.** Graph marks an endpoint slow if more than 10% of responses take
  over 3 seconds, and drops notifications for 10 minutes if more than 15% take over 10 seconds.

**Google** at `/api/hooks/google-workspace/{calendar,drive,directory,gmail}`:

- **Calendar, Drive and Directory channels:**
  - `events.watch` / `changes.watch` / `users.watch` with `{id: uuid, type: 'web_hook', address,
    token, expiration}`.
  - Check `X-Goog-Channel-Token` against the stored hash, and branch on `X-Goog-Resource-State`
    (`sync` means acknowledge only).
  - Channels **cannot be renewed**. Create a new one, then `channels.stop` the old one.
  - Drive `changes.watch` lasts at most 1 week. The body is empty, so always follow with
    `changes.list`.
- **Gmail via Pub/Sub push:**
  - Verify the `Authorization: Bearer` OIDC JWT: RS256 against Google's certs, `iss`
    `accounts.google.com`, the configured `aud`, `email` equal to the push service account, and
    `email_verified`.
  - Decode `{emailAddress, historyId}`.
  - `users.watch` must be renewed at least every 7 days; daily is recommended.
  - Gmail sends at most one event per second per user, and drops the excess.
- **Admin SDK Reports** (`activities.watch` for `drive`) is one domain-wide Drive activity feed,
  as an alternative to thousands of per-user Drive channels. Its latency is undocumented (§13 Q7).

## 11. Phases

| Phase | Scope | Microsoft | Google | Gate before GA |
|---|---|---|---|---|
| **0** | Kit seams (§4) | — | — | kit release 0.12.0 |
| **1** | Directory + calendar, org-wide, polling | `User.Read.All` `Group.Read.All` `Calendars.Read` (application) | `admin.directory.user.readonly` `admin.directory.group.readonly` `calendar.readonly` (domain-wide delegation) | publisher verification (MS) |
| **2** | Webhooks + renewal crons | same | same + Pub/Sub topic | — |
| **3** | Mail + files → knowledge (`ingestDocument`, owner-only), RBAC-scoped mail | `Mail.Read` `Files.Read.All` `Sites.Read.All` / `Sites.Selected` | `gmail.readonly` `drive.readonly` (restricted) | CASA (Google) |
| **4** | Per-user delegated connections, write actions | delegated + `offline_access` (admin pre-consent) | per-user OAuth client (Trusted, or verified + CASA) | refresh-token vault, re-auth UX |
| **5** | Optional MCP tool adapter for chat (§12) | Work IQ, Copilot-licensed tenants only | Google Workspace MCP, once GA | a kit MCP client |

The Google provider follows M365 on the same interface. Phase 1 is the first time it gets built.

## 12. MCP — could we drive a vendor server instead?

Checked September 2026:

| Server | Hosting | Auth | Tools | Prerequisites | Status |
|---|---|---|---|---|---|
| **Work IQ / Agent 365 MCP** (Microsoft) | remote, streamable HTTP, per-workload servers under `agent365.svc.cloud.microsoft` | Entra **delegated only**, admin consent, protected-resource metadata, no DCR | 10 generic verbs (`fetch`, `create_entity`, `ask`, `search_paths`, …) over mail, calendar, Teams, SharePoint, OneDrive | **Microsoft 365 Copilot licence per user**, Copilot Studio billing, Global Admin enablement | preview |
| **Microsoft MCP Server for Enterprise** | remote HTTP, `mcp.svc.cloud.microsoft/enterprise` | delegated | read-only Graph queries over **Entra directory data only** | none; 100 requests/min/user | preview |
| **Google Workspace MCP** (Gmail, Drive, Calendar, Chat, People) | remote, streamable HTTP, e.g. `gmailmcp.googleapis.com/mcp/v1` | per-user OAuth with **your own** pre-registered client, bearer token, no DCR; domain-wide delegation tokens undocumented | 6–10 per product: search, read, draft, list, free/busy | a GCP project in the Workspace Developer Preview | developer preview since 1 May 2026 |
| Community: `Softeria/ms-365-mcp-server` | Node, stdio or HTTP | delegated, OAuth 2.1 + DCR | broad M365 | a Node host (a Container, not a Worker) | active, MIT |
| Community: `taylorwilsdon/google_workspace_mcp` | Python, HTTP | delegated, multi-user OAuth 2.1 | broad Workspace | a Python host | active |

**Verdict: not a data plane.** Every server is delegated and interactive-shaped. None offers
app-only or domain-wide delegation access, delta or cursor semantics, or webhooks. The rate limits
and tool-at-a-time reads don't suit bulk sync or ACL-aware ingestion, so the connector is built on
the direct APIs.

**Where MCP fits (phase 5):** an optional, per-tenant **chat-tool adapter** for live, user-scoped
actions (draft a reply, find a free slot). It would reuse the phase-4 per-user tokens. Google's
servers are the realistic first target once GA; Work IQ only for tenants already paying for
Copilot. **The kit has no MCP *client* today.** It only *serves* MCP (the analytics plugin's
`/mcp`), so phase 5 starts with a kit seam: an MCP-backed tool source for `agentTools`.

## 13. Open questions

1. **Does a Google domain-wide-delegation-only third-party service account with restricted scopes
   need app verification or CASA?** There's no official answer.
   https://discuss.google.dev/t/does-oauth-app-verification-casa-apply-to-a-service-account-using-only-domain-wide-delegation-no-consent-screen-not-on-marketplace/395705,
   https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification,
   https://support.google.com/cloud/answer/13464323. *Assume yes and budget for it.*
2. **Microsoft certificate assertion:** PS256 with `x5t#S256` is what's documented now; RS256 with
   `x5t` is probably still accepted.
   https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
3. **Can `/adminconsent` consent to a subset of application permissions**, skipping `Mail.Read`
   for RBAC-scoped customers? Unverified; a second registration is the safe route.
   https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
4. **Is the Google webhook domain-verification requirement gone?** It's absent from the current
   docs. https://developers.google.com/workspace/calendar/api/guides/push
5. **Does Workload Identity Federation → `signJwt` → domain-wide delegation work end to end from a
   Worker?** Each step is documented, but there's no combined sample.
   https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers
6. **Do Entra federated identity credentials (the Worker as the OIDC issuer) work for cross-tenant
   client credentials in a multi-tenant app?** If so, the certificate goes away. Unverified.
7. **What is the Admin SDK Reports latency for Drive activity, and how are the Admin SDK scopes
   classified?** https://developers.google.com/workspace/admin/directory/v1/guides/push
8. **How do the Google 2026 quota tiers and billing thresholds apply?** They depend on usage
   between November 2025 and April 2026.
   https://developers.google.com/workspace/gmail/api/reference/quota,
   https://developers.google.com/workspace/calendar/api/guides/quota,
   https://developers.google.com/workspace/drive/api/guides/limits

Primary references:
- Graph subscriptions: https://learn.microsoft.com/en-us/graph/api/resources/subscription
- Graph webhook delivery: https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- Graph lifecycle events: https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
- Delta queries: https://learn.microsoft.com/en-us/graph/delta-query-overview
- Throttling: https://learn.microsoft.com/en-us/graph/throttling-limits
- Publisher verification: https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview
- User consent: https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/configure-user-consent
- Refresh tokens: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- Google service accounts: https://developers.google.com/identity/protocols/oauth2/service-account
- Domain-wide delegation: https://knowledge.workspace.google.com/admin/apps/control-api-access-with-domain-wide-delegation
- Domain-wide delegation best practices: https://knowledge.workspace.google.com/admin/apps/domain-wide-delegation-best-practices
- Trusted apps: https://knowledge.workspace.google.com/admin/apps/authorize-unverified-third-party-apps
- Gmail push: https://developers.google.com/workspace/gmail/api/guides/push
- Pub/Sub push auth: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
- Calendar sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Drive push: https://developers.google.com/workspace/drive/api/guides/push
- Work IQ MCP: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/work-iq/mcp/overview
- Microsoft Graph MCP server: https://learn.microsoft.com/en-us/graph/mcp-server/overview
- Google Workspace MCP servers: https://developers.google.com/workspace/guides/configure-mcp-servers

## 14. Known gaps

- **Admins can read everything synced.** Under D29, "owner and admins only" means exactly that, so
  there's no mode that hides one employee's mail from a tenant admin. The Connections page states
  this before consent.
- **No provider-ACL mapping.** A shared file or group calendar is owner-only, not shared with its
  provider audience, until groups are mapped (the kit's §1 already lists "no IdP group sync").
- **Unmatched directory users** (no kit account) own nothing, so only admins see their rows.
- **Secret rotation is manual.** The Entra client secret expires in at most 24 months, and rotating
  `OAUTH_ENCRYPTION_KEY` breaks every sealed BYO secret and refresh token (§16: no re-encrypt path).
- **No webhooks in phase 1**, so calendar freshness is the cron cadence (15 minutes).
- **One installation per provider per tenant.** A customer with two Entra tenants needs two kit
  tenants.
- **No write actions, no mail or files until phase 3, no per-user connections until phase 4, and no
  MCP client until phase 5.**
- **Backfill is paged job chains, not a Workflow.** A 10,000-mailbox tenant's first sync is many
  small jobs, bounded by queue concurrency, and there's no progress bar beyond per-cursor status.
