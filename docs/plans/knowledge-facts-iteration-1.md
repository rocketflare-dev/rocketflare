# Knowledge facts, iteration 1 (D43)

The decisions behind this plan are in `docs/plans/knowledge-base-review.md` §10, and the gaps it
closes are in §5 of the same file. This document is the plan for building it.

## Goal

A Rocketflare app's knowledge base stops being a heap of passages. After this iteration it
does four things:

1. It extracts **typed facts** from documents.
2. It attaches those facts to the app's **own domain rows**, or to staging entities until a row
   exists.
3. It keeps each fact's **source span, trust level and validity**.
4. It tells people and agents when a fact is **unconfirmed or contradicted**.

It is built on retrieval we can now measure: a fixture, recall@k and a reranker. It also gets
the lifecycle repairs the facts depend on.

The whole iteration ships as **one kit minor release** (0.37.0), from one feature branch. Each
phase below is its own commit, and the gate passes after every phase.

## Progress

Branch `feat/knowledge-facts`, one commit per phase, the gate green after each.

| Phase | Commit | State |
|---|---|---|
| 0: measure | `0a59efe` | done: Brightside corpus, retrieval suite, baselines |
| 1a: chunk structure, lexical index, content hash | `d5e8c14` | done (plus table-aware chunking, from the agentic-mapper review) |
| 1b: re-embed, DLQ, retry, ingest span | `2301da8` | done |
| 1c: rerank seam, metering, daily cap | `146d3eb` | done: R@10 1.00, MRR 0.84 with Fireworks (0.66 without) |
| 2a: contracts, tables, entity-type registry | `99d2e1a` | done |
| 2b: extraction job, facts eval | `1f2e17c`, `8c1e25b` | done: Haiku precision 0.93, recall 0.71, conflicts caught 0.83, false alarms 0.14 (target 0.10 unmet, see the gaps) |
| — test fixes | `54cfa52` | the api suites block outbound network; three slow tests fixed at the cause |
| 2c-1: review API, `lookup_facts`, conflicts chat eval | `5431c6e` | done: chat · conflicts 16/18, no answer left a side out |
| 2c-2: review UI, chat entity cards, decisions kept | `03076f2` | done |
| local test in a dev instance | — | done 2026-11-17: Brightside loaded into a dev tenant; search latency fixed with `RERANK_CANDIDATES` (default 20) |
| 3: docs and release | — | doc sweep done (uncommitted, for review): CONCEPTS §9 gaps, SETUP flag + entity types, rules, ADAPTING row, rf-how-do-i entry, README, the unreleased note; then `pnpm kit:release 0.37.0` |

Decided along the way: the `knowledge-facts` flag ships default OFF for 0.37.0; `pg_trgm` is in
migration 0028 (and `scripts/migrate.ts`); `toMarkdown` emits no page markers, so `chunks.page`
stays null.

## Phase 0: measure (kit-only)

**The fixture.**
- **Content:** a fictional small business with about 40 documents (contracts, call notes, email
  threads, a price list, onboarding notes).
- **Where it lives:** `apps/evals/datasets/kit-only/brightside/`, with `apps/evals/datasets/kit-only/**`
  added to `kitOnly` in `.rocketflare.json`.
- **Answer key** (in the same directory):
  - `retrieval.jsonl`: each query with the document ids and passage text expected to answer it.
    Store passage text, not chunk ids, so the key survives a change to the chunker.
  - `facts.jsonl`: the facts planted in the documents, each with its entity, key, value, source
    and validity.
  - `conflicts.jsonl`: the pairs of facts planted to contradict each other, and which one should
    win.
- **Embeddings:** the documents are ingested through the real pipeline. They are never seeded with
  deterministic vectors.

**Scorers** in `apps/evals/kit/`:
- `RecallAtK` and `MRR`: whether an expected passage appears in the top k, and how high. Computed
  in code, with no judge.
- `ContextPrecision`: a judge scores how much of what was retrieved was actually relevant.
- `FactExtraction`: precision and recall of extracted facts against `facts.jsonl`, matched on
  entity, key and normalised value.
- `ConflictDetection`: share of planted conflicts flagged, and share of flags that are false
  alarms.

**Suites:**
- `suites/knowledge/retrieval.eval.ts` and `suites/knowledge/facts.eval.ts`.
- `knowledge-chat.jsonl` grows from 5 cases to at least 25, generated against the fixture.
- These stay inside `pnpm eval`, never the gate (D33).
- `pnpm eval:baseline` records the "before" numbers **on `main`'s retrieval, ahead of any other
  phase**.

**Exit:** a baseline file for retrieval and chat, committed under `apps/evals/baselines/`.

## Phase 1: foundations

1. **Structure-aware chunking** (`apps/web/src/api/services/ai/chunking.ts`).
   - **Boundaries:** the chunker recognises markdown headings and keeps them as hard boundaries.
     Each chunk carries `headingPath` (for example `Pricing › Annual plans`) and, for a PDF,
     `page`, read from the page markers `toMarkdown` emits. Check whether it emits them; if it
     does not, record page as a known gap.
   - **Spans:** each chunk records `charStart` and `charEnd` in the document's text, replacing
     today's approximate `position()` offset.
   - **Window size:** the 800/100 window stays. Measure it against the fixture before tuning.
   - **Embedding input:** the heading path is prefixed to the text that gets embedded and
     lexically indexed, but not to the stored chunk. That gives a cheap first share of
     Contextual Retrieval's benefit, before the LLM prefixes of iteration 2.
2. **Generated lexical index.**
   - `chunks.search_vector` becomes a generated `tsvector` with a GIN index, built from heading
     path plus text.
   - Retrieval reads the column instead of computing `to_tsvector` per query.
   - The text-search configuration becomes a constant `SEARCH_TEXT_CONFIG` (it stays `'english'`).
     Making it vary per tenant is iteration 2.
3. **Content hash.**
   - `documents.contentHash` stores a sha-256 of the normalised text.
   - On an upsert, a matching hash skips chunking, embedding **and extraction**.
   - A plain ingest (no `externalId`) with a hash that matches an existing document in the same
     tenant and source returns that document (`200`, `deduplicated: true`) instead of creating a
     second one.
4. **Model-consistent dense search.**
   - `chunks.embeddingModel` is set per chunk, and the tenant dense leg filters on the query
     vector's model, in the same way the platform leg already does.
   - Documents embedded with a model other than the current one stay findable lexically, and a
     `stale_embedding` count shows up in the health endpoint.
   - **Re-embed job:** a `document.reembed` job re-embeds one tenant's stale chunks in batches,
     reusing `indexDocument`. It runs from `POST /api/ai/documents/reembed` (admin), and is
     enqueued automatically when a tenant changes its embeddings default.
5. **Failure recovery.**
   - **DLQ:** turn on `dead_letter_queue` in both tomls. Name it `rocketflare-jobs-dlq` in the
     production toml and `-staging` in the staging one, so the parity test stays green. Provision
     both queues in `pnpm provision`.
   - **Retry:** `POST /api/ai/documents/:id/retry` (owner or admin) re-enqueues a `failed`
     document, and the Documents page shows a Retry button.
   - **Tracing:** inline ingest gets a span.
6. **Reranker seam.**
   - The seam: `RerankFn = (query, candidates) => Promise<scored[]>` in
     `apps/web/src/api/services/ai/rerank.ts`, with `scope: 'rerank'` added to `AI_SCOPES`.
   - **Default:** Workers AI `@cf/baai/bge-reranker-base` with a sigmoid, applied to the top 50
     fused candidates and then cut to `limit`.
   - **Tenant override:** a key in `ai_configs` can point at a Cohere- or Voyage-style
     `/rerank` endpoint. Lift the client from the global-search plugin, then have that plugin call
     the core seam.
   - **Without a reranker:** with no `[ai]` binding and no tenant key, there is no reranking,
     exactly as today.
   - **Threshold:** `RERANK_MIN_SCORE` is applied after reranking. It defaults to off; set its
     value from the fixture.
7. **Metering and caps.**
   - Embedding, reranking and extraction calls go through `recordUsage` into `ai_usage`, with
     kinds `embeddings`, `rerank` and `extraction`.
   - **Cap:** `KNOWLEDGE_TENANT_DAILY_COST_USD` (unset means no cap). When the cap is reached,
     extraction pauses: the job waits and retries tomorrow. Indexing never pauses, because search
     must keep working.

**Exit:**
- `pnpm gate` passes.
- On the fixture, recall@10 and MRR are **at least the baseline**, and reranking improves MRR.
- The numbers are recorded in the PR description.

## Phase 2: facts and entities

### Contracts (`packages/shared/src/ai/knowledge-facts.ts`)

- `entityTypeSchema` describes what an app declares: `type` (namespaced; a plugin's type uses its
  `<id>.` prefix), `label`, and `facts`, a zod object whose keys are the fact keys and whose
  values are the expected value schemas. Each key can carry a `description` that steers
  extraction.
- **Fact states:** `accepted`, `unconfirmed`, `conflicting`, `superseded` and `rejected`.
- **Source trust:** `person` > `upload` > `agent` > `integration`.
- Also: the fact and entity-card response schemas, the review action, and `factHitSchema` for
  tool results.

### Schema (`apps/web/src/db/schema/`)

Every table below calls `tenantIsolation()`.

- **`knowledge_entities`**, the staging entities:
  - columns: `id`, `tenantId`, `type`, `name`, `aliases text[]`, `promotedTo` (type plus row id,
    nullable), `mergedInto`, and an embedding of the name and aliases, used for resolution;
  - a trigram index on `name`. `pg_trgm` is available on Neon and in our Docker image; confirm it
    in both.
- **`knowledge_facts`**:
  - **identity:** `id`, `tenantId`, `entityKind` (`domain` or `staging`), `entityType`,
    `entityId` (text);
  - **content:** `key`, `value jsonb`, `valueText` (normalised, for display and matching);
  - **source:** `documentId`, `chunkId` (nullable), `charStart`, `charEnd`, `quote`;
  - **trust:** `sourceKind` (the trust enum), `confidence`;
  - **state:** `state`, `supersededById`, `conflictsWith uuid[]`;
  - **time:** `validFrom`/`validTo` (when the fact was true in the world, nullable),
    `observedAt` (when we learned it), `confirmedBy`/`confirmedAt`;
  - **access:** `reviewerUserId` (who is asked), `visibility` (`tenant` or `groups`, plus
    `private` reserved for a future memory plugin), inheriting the source document's grants
    through `documentId`.
- **Deletes:** deleting a document removes its facts. Deleting the last fact for a staging entity
  leaves the entity in place.

### Registry

- `ServerPlugin.knowledgeEntityTypes?: EntityTypeRegistration[]` is a new slot, and a matching
  `apps/web/src/api/services/knowledge/entity-types.ts` holds the app's own registrations. A copy
  edits that file, the same way it owns its routes.
- **A registration:**

  ```ts
  { type, table, idColumn, labelColumn, aliasColumns?, facts, resolve?(name, scope) }
  ```

  `resolve` is the tenant-scoped lookup that maps a mention to candidate rows. The default
  matches on label and aliases, using trigram plus the embedding.
- **A sample type for the reference plugin:** `example-feature` registers `example.order`, so the
  plugin contract has a test and the docs have an example. The kit core registers no domain types
  of its own.
- **Barrels:** this is the seventh plugin barrel slot.
  - Update `docs/plugin-api.md` with `node scripts/plugin-api-doc.mjs`, `CONCEPTS.md` §16 and
    `apps/web/src/plugins/CLAUDE.md`.
  - Update the CLAUDE.md lines that say "six barrels", if the slot counts as a barrel. It is a
    field on `ServerPlugin`, so it probably does not, and nothing changes. Check.

### Extraction (`knowledge.extract` job)

- **When it runs:** it is enqueued after `indexDocument` succeeds and the content hash changed. It
  runs only when the tenant has the `knowledge-facts` feature flag (D30) and at least one entity
  type is registered.
- **The pass, per document:**
  - The prompt includes the registered types, their fact schemas, and the facts already accepted
    for entities the document mentions.
  - One structured `submit_facts` call goes to the tenant's **decisions or chat model**, through
    `resolveDecisions` and then the chat model, the way D37 resolves decisions.
  - A long document is processed in heading-bounded sections.
- **Verifier pass:** each candidate's `quote` must occur verbatim in the chunk it cites, or the
  candidate is dropped. This is the check Cloudflare Agent Memory runs.
- **Dates in code:** dates are normalised in code, never by the model. Relative dates are resolved
  against the document's date.
- **Entity resolution:** each mention goes through registered `resolve`, then the staging
  entities, then a new staging entity.
  - One candidate above the match threshold links to it.
  - Several candidates, or one just under the threshold, go to a staging entity with a
    `possibleMatch` review item.
- **Deciding a fact's state** (decision 3):

  | Compared with what we hold | Result |
  |---|---|
  | Nothing held | `accepted` if confidence ≥ threshold, else `unconfirmed` |
  | Same value | `accepted`; adds a second source; can confirm an `unconfirmed` one |
  | Different value, and the source is newer **and** at least as trusted | `conflicting` on both, a review item, and the newer one is preferred in answers |
  | Different value otherwise | `conflicting`, a review item, and the older accepted one is preferred |

  "Preferred" only changes the order in which answers state the facts. Both are always cited.
- **Never automatic:** a fact never writes to a domain column. Promoting a staging entity to a
  domain row, or applying a fact to a domain column, is an approval-gated action, following the
  `Tool.requiresApproval` pattern in `research-topic.ts`.
- **Cost and limits:** usage is recorded as `extraction`, and the tenant cap from phase 1 applies.

### Review (decisions 4–5)

- **Reviewer:** `reviewerUserId` is set to the document owner. For a document a plugin ingested,
  it is the user the plugin names when it ingests. `ingestDocument` gains an optional
  `reviewerUserId`, which is the person who connected the integration, and falls back to tenant
  admins.
- **Endpoints:**
  - `GET /api/knowledge/review` lists open items for me, or for everyone if I'm an admin.
  - `POST /api/knowledge/facts/:id/review` takes `{ action: confirm | reject | prefer }`.
  - `POST /api/knowledge/entities/:id/merge` and `/promote`.
- **UI:**
  - **Entity card:** a card in chat, and a `/knowledge/entities/:type/:id` page listing the
    entity's facts with their sources, states and validity.
  - **Inline doubt:** unconfirmed and conflicting facts carry a small "Is this still right?"
    with Confirm, Not right and Use this one.
  - **Badge:** a count badge on the Documents nav for open items. There is no queue page beyond a
    filtered list.
  - **No toasts:** no success toasts, only errors, per the toasts memory.

### Retrieval of facts

- **New tool, `lookup_facts`:**
  - input: `{ entity?, type?, key?, asOf? }`;
  - output: facts grouped by entity, each with its state, source title, quote and validity.
  - Unconfirmed and conflicting facts come back **labelled**, with both sides and their sources.
- **`search_knowledge`** adds a `facts` block for entities whose names match the query, so a
  single call returns passages and the facts about the entities mentioned.
- **Prompt rule:** the system prompt and tool descriptions require the model to state the
  uncertainty and cite each side, never to pick a side silently.
- **Access:** facts inherit document visibility through `visibleDocuments(scope)`. A fact whose
  document you cannot see does not exist for you.

**Exit:**
- On the fixture, `FactExtraction` precision is at least 0.9 and recall at least 0.7.
- `ConflictDetection` catches at least 0.8 of the planted conflicts, with a false-alarm rate of
  0.1 or less.
- Chat answers about planted conflicts mention both sides, checked with a rubric judge.
- These thresholds are first guesses. Adjust them after the first run, and record the reason in
  the PR.

## Gaps found during the build

Recorded as they turn up. Each one either folds into a later phase of this iteration or stays a
Known gap in `docs/CONCEPTS.md` §9 for iteration 2.

| Gap (found in) | Effect on the fixture | Where it goes |
|---|---|---|
| One service named two ways ("Car park and entrances gritting — annual plan" / "Winter gritting (annual plan)") stays two staging entities (2b) | most of Haiku's false alarms; both `grit-annual-price` conflicts missed | **2c**: the possible-match review item and `POST /entities/:id/merge` let a person join them. Automatic linking stays iteration 2 |
| Partial person name as a value ("Marcus" vs "Marcus Bell") is a conflict (2b) | most of Sonnet's false alarms | **2c**: "Use this one" / "Not right" dismisses it. Matching a name to its fuller form stays iteration 2 |
| Two wordings of one unit ("per call-out" / "per visit") conflict (2b) | one false alarm per run | **2c**, as above. Iteration 2: a key may declare an enum, or a synonym-tolerant comparison |
| The model sometimes reads proposed values from a proposal (2b) | occasional | Iteration 2 (prompt and eval) |
| The false-alarm target (≤ 0.10) is unmet: Haiku 0.14, Sonnet 0.17, ±0.1 run to run (2b) | — | Recorded with the reason in CONCEPTS and the PR, per the exit rule |
| A section's ambiguous candidates (`dropped.ambiguous`) may still create a staging entity with no facts (2b) | none measured | Iteration 2: resolve after the ambiguity check |
| A person's `reject` / `prefer` is lost when the rejected fact's own document is re-extracted (its text changed) (2c-1) | none measured: the fixture is extracted once | **Resolved in 2c-2**: decided facts stay in the table through the re-read, and a reading of the same entity, key and value reuses the row with its decision (no migration) |
| `search_knowledge`'s facts block finds only entities with a staging row; a domain row that never had one is reached through `lookup_facts`' resolver only (2c-1) | none: the fixture registers no domain types | Iteration 2: run each type's resolver over the query's noun phrases |
| A possible match whose every staging candidate is hidden from the reviewer is dropped from their list but still counted in `pagination.total` (2c-1) | none | **Resolved in 2c-2** (the badge shows the count): `hasVisibleCandidateSql` in the list's WHERE |
| Nothing nudges the UI when a review item is settled (2c-1) | — | **Resolved in 2c-2**: every review action and each extraction run that wrote facts nudges `entity.changed { entity: 'knowledge' }` after commit |
| A decision carries over only when the re-read repeats the exact entity, key and value; a reworded value or a differently resolved entity comes back as a new open item (2c-2) | none measured | Iteration 2: match on the key's normalised value, and on a merged entity's survivor |
| Promote asks for the domain row's id; there is no picker over the type's rows (2c-2) | none: the fixture registers no domain types | Iteration 2: a picker over the type's resolver |
| The agent-run timeline shows no entity cards; only chat does (2c-2) | — | Iteration 2: emit `kit.entity` in the run projection beside `kit.document` |
| The nudge carries no reviewer, so every member's badge refetches on any settle (2c-2) | — | Iteration 2, if the refetch shows up in load: `nudgeUsers` to the reviewers |
| Chat search felt slow in local testing: 2.4 s for one `search_knowledge` call, 2.0 s of it the Fireworks rerank over 50 chunks (local test) | median rerank 810 ms at 50 candidates | **Resolved**: `RERANK_CANDIDATES` (default 20): median 465 ms with the same R@5, R@10 and MRR, because every answer passage was already in the fused top 20 |
| Workers AI `bge-reranker-base`, the kit's default reranker, is unmeasured on the fixture (local test) | — | **Deferred to iteration 2** (decided 2026-11-17): `pnpm eval retrieval --rerank workers-ai` with a Cloudflare API token; check recall and latency at 20 candidates and its 512-token input limit against chunk size. Stays a CONCEPTS Known gap |

## Phase 3: docs and release

- **`docs/CONCEPTS.md` §9:**
  - **Knowledge:** chunk structure, generated tsvector, rerank seam, model filter, re-embed,
    content hash, retry, metering.
  - **New subsection, Knowledge facts (D43):** registry, states, trust, review, tools.
  - **Known gaps:** iteration 2's issues, the §8 items that remain, page numbers if `toMarkdown`
    gives none.
- **Other docs:**
  - `SETUP.md` and `.dev.vars.example`: `KNOWLEDGE_TENANT_DAILY_COST_USD` and the feature flag.
  - `docs/DEPLOY.md` and both toml comments: the DLQ.
  - `.claude/rules/api.md` and `database.md`, and `apps/web/src/api/services/ai/CLAUDE.md`:
    delete the phantom `RerankFn` line.
  - `apps/web/src/plugins/CLAUDE.md` and `docs/plugin-api.md`: the new slot.
- **`docs/upgrades/unreleased.md`:**
  - **Migrations:** `chunks` (heading path, spans, model, search vector), `documents`
    (content hash), and the two new tables.
  - **DLQ provisioning.**
  - **Behaviour changes:** dedupe returns the existing document, and the dense leg filters by
    model, with a re-embed being the fix.
  - **Optional for a copy:** registering entity types.
- **Upgrade note for copies:** a copy whose rows have no `chunks.embeddingModel` needs it filled
  in from `documents.embeddingModel` within the migration, or every tenant's dense search returns
  nothing after the upgrade. Test this against a database migrated from 0.36.1.
- **Skills:** a short `rf-how-do-i` entry, "register an entity type", per the kit-features memory.
  Decide whether that is enough or whether a skill is due.
- **Release:** `pnpm kit:release 0.37.0`.

## Risks

- **Extraction cost on large imports.** The inbox plugin backfilling a mailbox could extract
  thousands of documents. Mitigations: the content-hash skip, the daily cap, and the queue's
  natural throughput limit. Measure cost per fixture document and put the figure in CONCEPTS.
- **Wrong entity resolution** attaching facts to the wrong customer is the worst failure here,
  and cross-tenant attachment is impossible by construction. Hence the bias to the staging entity
  with a possible-match review item, rather than an automatic link below the threshold.
- **Reranker latency** on chat. bge-reranker over 50 candidates should be ~100 ms; measure it,
  and skip reranking when the query has a single lexical hit.
- **Migration on large `chunks` tables.** Adding a generated column rewrites the table. Note it
  in the upgrade note and recommend a maintenance window above about 1M chunks.

## Open questions for build time

- Does `toMarkdown` mark page boundaries in its PDF output?
- Is `pg_trgm` enabled on the Neon projects that `pnpm provision` creates?
- Should the feature flag `knowledge-facts` default to on for new tenants once it is released, or
  stay opt-in for one release?
