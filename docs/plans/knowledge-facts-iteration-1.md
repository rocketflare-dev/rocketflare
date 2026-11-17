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
