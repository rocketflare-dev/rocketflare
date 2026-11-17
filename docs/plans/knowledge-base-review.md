# Knowledge base review: Rocketflare against current practice (November 2026)

The knowledge base is the part of a Rocketflare app that should come to know the business it
serves: the documents its people upload or sync, and the facts about customers, contracts and
products held in them. This review compares what the kit ships on `main` (0.36.1) with three
outside reference points:

- **Frameworks:** Mastra, LangChain, LlamaIndex, and the graph-memory projects.
- **Cloudflare:** its own recommendations, chiefly AI Search and Agent Memory.
- **Anthropic:** its recommendations on retrieval, citations and context.

It covers capabilities, gaps, developer experience, maintainability and operations, and ends
with the decisions taken after the review (§10).

Benchmark figures marked *(vendor)* are self-reported by whoever sells the system. File
references are to `main` at `e378d21`.

## 1. Summary

The retrieval core is in better shape than most starter kits, and in places it matches the
managed products:
- **Hybrid search.** Dense and lexical search are fused with reciprocal rank fusion (RRF, k=60).
  This is the same design Cloudflare AI Search and OpenAI `file_search` use.
- **Filtered vector search that still fills its top-k.** pgvector 0.8 iterative scans are on
  whenever a filter applies.
- **Permissions in SQL.** Group- and owner-level visibility is enforced in SQL, not by the model.
- **Retrieval the agent asks for.** Retrieval is a set of tools the model calls when it needs them
  (`search_knowledge`, `get_document`, `list_documents`). This is the pattern Anthropic's
  context-engineering guidance recommends.
- **Checked citations.** Agents verify their citations against the ids the tools actually
  returned.

The gaps fall into four groups:

1. **Retrieval quality.**
   - No reranker. The `RerankFn` "seam" the code describes exists only in comments.
   - No contextual chunking.
   - Chunks don't know their heading or page.
   - Lexical search is English-only, although the default embedder is multilingual.
   - No relevance threshold.
2. **Lifecycle.**
   - Changing a tenant's embedding model silently mixes two vector spaces.
   - There is no re-embed or reindex path.
   - Without an `externalId` nothing is deduplicated.
   - A failed document stays failed, since there is no dead-letter queue or retry.
   - Embedding spend is not metered.
3. **Second-brain semantics.**
   - The knowledge base holds passages, not knowledge.
   - There are no entities, no facts, and no notion of a fact being replaced or contradicted.
   - There are no collections or tags.
   - The only connector that ingests is the inbox plugin.
   - Nothing exposes the knowledge base over MCP.
4. **Measurement.** We cannot tell whether a change improves retrieval.
   - There is no recall@k or MRR metric.
   - The knowledge chat eval has 5 cases.
   - Dense search over the demo seed is noise.

**Recommendation.** Keep the knowledge base on Postgres and pgvector and evolve it in place. The
deciding reason is that a Rocketflare app's knowledge base sits in the same database as its domain
tables, under the same tenant isolation. That makes the second brain possible: facts pulled from
documents can point at the app's real customer and contract rows. Neither a hosted search product
nor a framework's vector store can do that. §7 compares the options and §10 records the plan.

## 2. Scorecard

The gap column uses three levels: **none** (we match current practice), **minor** (some of it
is missing), and **major** (it is missing and it matters).

| Area | Rocketflare today | Current practice | Gap |
|---|---|---|---|
| Parsing | `AI.toMarkdown` for PDF/Office/HTML; images excluded, no OCR (`packages/shared/src/ai/embeddings.ts:99-137`) | AI Search: OCR on all accounts; LlamaParse agentic tiers | minor |
| Chunking | 800-token windows (4 chars/token estimate), 100 overlap, paragraph split only (`apps/web/src/api/services/ai/chunking.ts:11-73`) | Structure-aware (markdown/HTML headers), heading path on chunk, page numbers; Mastra ships 9 strategies | major |
| Contextualisation | none | Anthropic Contextual Retrieval; late chunking; `voyage-context-3` | minor (next iteration) |
| Embedding lifecycle | `embeddingModel` recorded, never filtered for tenants (`apps/web/src/api/services/ai/retrieval.ts:273-279`); no re-embed | Model recorded per row, filtered at query time, re-embed job | major |
| Hybrid search | dense + `ts_rank_cd` over a tsvector computed per query, RRF k=60 (`apps/web/src/api/services/ai/fusion.ts:11-33`) | Same fusion, over a stored index (generated tsvector + GIN, or BM25) | minor |
| Reranking | none in core; global-search plugin has one for the ⌘K palette only | Cross-encoder over 50–150 candidates (Anthropic: −67% failures with contextual + rerank) | major |
| Query rewriting | none | AI Search rewrites follow-up turns; OpenAI `rewrite_query` | minor |
| Relevance threshold | none ("nearest-neighbour, not a relevance threshold", `search-knowledge.ts:18-22`) | `score_threshold` (OpenAI), `match_threshold` (AI Search) | minor |
| Filters / metadata | document id only; `sources[]` internal | Typed attribute filters (OpenAI: 16 keys; AI Search: 5 fields), recency boost | minor |
| Access control | tenant + owner + groups in SQL (`apps/web/src/api/services/access.ts:48-52`) | Same, plus ACLs synced from the source system for connectors | none for uploads; minor for connectors |
| Citations | document-level; agents verify ids (`research-topic.ts:148-161`) | Span-level: Anthropic `search_result` blocks / Citations API | minor |
| Agent tools | search / get / list, budgets, actionable empty results | Anthropic "writing tools for agents": same, plus `response_format` | none |
| Entities / facts | none on `main` | Graphiti, Hindsight, Mastra Extractors, Glean's graph | major |
| Temporal validity | `createdAt`/`updatedAt` only | Bi-temporal facts, superseded rather than overwritten (Graphiti) | major |
| Connectors | inbox plugin only; m365 files "designed, not built" (`docs/CONNECTORS.md`) | Glean/Notion: dozens, with permission sync and freshness status | major (plugin territory) |
| MCP exposure | none | AI Search ships `/mcp`; Glean, Notion MCP | minor (next iteration) |
| Retrieval evals | faithfulness judge over 5 chat cases; no recall@k/MRR | Golden set with expected chunk ids, recall@k/MRR/nDCG + context precision, in CI | major |
| Tracing | `retrieval search_chunks` and embedding spans; inline ingest untraced | Per query: rewrites, candidates, rerank scores, final context | minor |
| Cost metering | embedding prices known, never written to `ai_usage` | Metered per tenant, capped | major |
| Ops tooling | no DLQ (`apps/web/wrangler.toml:147` commented out), no reindex/retry, no index stats | Retry and reindex in UI, health view | major |
| Multilingual | bge-m3 dense, `'english'` lexical (`retrieval.ts:41`) | Language-aware or `simple` config | minor |

## 3. How it works today

**Ingest.**
- **Entry points:** `POST /api/ai/documents/ingest` (text) and `/upload` (multipart) in
  `apps/web/src/api/routes/ai-documents.ts`. Plugins use `ingestDocument*` from
  `apps/web/src/plugins/api/knowledge.ts`.
- **Conversion:** binary uploads go through `env.AI.toMarkdown` (`convert.ts`) in a
  `document.convert` job.
- **Limits:** 5 MB per upload and 500,000 characters of text.
- **Indexing:** a document of 50 chunks or fewer is indexed inline in the request; larger ones are
  enqueued as `document.index` (`ingest.ts:44`).
- **Re-ingest:** an upsert on `(tenant, source, externalId)` replaces the chunks and grants in one
  transaction.
- **Failure:** a failure marks the document `failed` with a redacted error and the queue retries
  three times. There is nothing after that.

**Embedding.**
- Every provider is reduced to 1024 dimensions (`packages/shared/src/ai/config.ts:217`). The
  default is `@cf/baai/bge-m3`; OpenAI `text-embedding-3-*` is sent `dimensions: 1024`.
- **Resolution order:** the tenant's `ai_configs` embeddings default, then Workers AI, then
  `EMBEDDINGS_API_KEY`, then a 503 (`resolve.ts:328-418`).
- Batches of 32.

**Storage.**
- Tables: `documents`, `chunks` (one global HNSW cosine index, default parameters) and
  `document_groups`.
- Lexical search computes `to_tsvector('english', text)` at query time, so there is no stored
  tsvector and no GIN index (`chunks.ts:6-7` names this as the scaling path).

**Retrieval** (`retrieval.ts:197-386`):
- **Dense:** cosine over a candidate pool of `min(max(4·limit, 50), 200)`.
- **Lexical:** up to 32 OR-ed terms ranked by `ts_rank_cd`.
- **Fusion:** RRF with k=60.
- **Iterative scan:** `hnsw.iterative_scan = relaxed_order` is set when a visibility or source
  filter applies.
- **Results:** each hit carries its dense and lexical ranks and an approximate character offset.
- **Without an embedder:** the HTTP API returns 503; the plugin API falls back to lexical search.

**Generation.**
- **Tools only:** chat and agents reach knowledge only through tools. Nothing is injected into the
  prompt.
- **Chat limits:** up to 6 tool turns, behind `CHAT_KNOWLEDGE_TOOLS`.
- **Document cards:** rendered in chat from `kit.document` events.
- **`research-topic`:** drops citations it did not retrieve.
- **`triage-research`:** sifts passages with `ctx.decide.sift('relevant')` at p ≥ 0.5. This is the
  nearest thing to a reranker in core.

**Around it.**
- **guide plugin:** writes platform documents.
- **global-search plugin:** fans out to providers with its own optional reranker.
- **web-knowledge:** fetches live pages without ingesting them.
- **inbox plugin:** ingests mail and attachments.
- **Per-person memory (D36):** exists only on the unmerged `feat/memory-d36` branch, forked at
  0.16.3.

## 4. The landscape

### 4.1 Mastra (TypeScript, 1.x)

Mastra went 1.0 in January 2026 and has shipped minor releases roughly weekly since
([1.0](https://mastra.ai/blog/announcing-mastra-1)).

**RAG.**
- **Chunking:** `MDocument.chunk()` offers recursive, character, token, markdown, semantic-markdown,
  html, json, latex and sentence strategies, plus an optional LLM `extract` step for summaries and
  keywords ([chunk reference](https://cdn.jsdelivr.net/npm/@mastra/rag@2.4.0/dist/docs/references/reference-rag-chunk.md)).
- **Query tool:** `createVectorQueryTool()` lets a filter or index be injected per request through
  `requestContext`, which is how tenant scoping would be enforced. It has a built-in score blend
  and pgvector `ef`/`probes` options
  ([tool](https://cdn.jsdelivr.net/npm/@mastra/rag@2.4.0/dist/docs/references/reference-tools-vector-query-tool.md)).
- **Reranking:** `rerank()` works with Cohere or an LLM scorer.
- **GraphRAG:** this is a similarity graph over the retrieved chunks, held in memory. It is not a
  stored knowledge graph ([example](https://mastra.ai/examples/rag/usage/graph-rag)).
- **No BM25 on pgvector.** Its PgVector store has no BM25 hybrid; Mastra's "hybrid" example means
  vector plus a metadata filter. Real BM25 exists only in its file-oriented Workspace search
  ([docs](https://mastra.ai/docs/workspace/search)).

**Memory.**
- **Observational Memory** became the default in February 2026. An observer compresses history
  into dated observations; it scores ~95% on LongMemEval *(vendor)*
  ([post](https://mastra.ai/blog/observational-memory)).
- **Memory Extractors** (July 2026) pull Zod-typed values out of conversations, with a callback to
  write them to your own database ([post](https://mastra.ai/blog/introducing-memory-extractors)).
  This is the closest published pattern to the facts layer in §10.

**Evals.** Built-in faithfulness, context-relevance and context-precision scorers
([scorers](https://mastra.ai/docs/scorers/built-in-scorers)).

**Operational caveats.**
- On Workers, Mastra's D1 storage cannot persist traces and caps rows at 1 MiB
  ([D1](https://mastra.ai/reference/storage/cloudflare-d1)).
- Compromised `@mastra/vectorize` versions were published during the Mastra supply-chain attack
  ([Socket](https://socket.dev/npm/package/@mastra/vectorize)).

**What to take:** the chunking strategies, the typed-extractor pattern and the scorer definitions.
Not the framework (§7).

### 4.2 LangChain.js and LlamaIndex

- **LangChain's Indexing API** hashes content and uses a `RecordManager` to make re-sync
  incremental: unchanged content is skipped, and content that vanished from the source is deleted
  ([JS indexing](https://js.langchain.com/docs/how_to/indexing)). This is the reference pattern
  for connector sync, and we have no equivalent.
- **Retrievers moved to legacy:** LangChain v1 moved ParentDocument, SelfQuery and MultiVector
  into `@langchain/classic` ([migration](https://docs.langchain.com/oss/javascript/migrate/langchain-v1)).
  That is churn a dependent would absorb.
- **LlamaIndex auto-merging retrieval** indexes small leaf chunks and returns the parent section
  when enough siblings match
  ([auto-merging](https://developers.llamaindex.ai/python/examples/retrievers/auto_merging_retriever/)).
- **LlamaParse** remains the quality bar for parsing difficult PDFs, tables and scans
  ([agentic OCR](https://www.llamaindex.ai/blog/ocr-is-dead-long-live-agentic-ocr)).

### 4.3 Graph and temporal memory

| System | What it adds over vector RAG |
|---|---|
| Zep / Graphiti | Bi-temporal knowledge graph: when a fact was true and when it was recorded; superseded edges are invalidated, not deleted ([paper](https://arxiv.org/abs/2501.13956)) |
| Microsoft LazyGraphRAG | Answers questions about a whole corpus at vector-RAG indexing cost, by building graph structure at query time ([MSR](https://www.microsoft.com/en-us/research/blog/lazygraphrag/)) |
| LightRAG | Two retrieval levels, specific entities and broad themes, with incremental graph updates ([arXiv](https://arxiv.org/abs/2410.05779)) |
| Cognee | add → cognify (entities, summaries, embeddings) → search pipeline ([blog](https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory)) |
| Letta | Editable memory blocks rewritten by background "sleep-time" agents ([docs](https://docs-v1.letta.com/guides/agents/sleep-time-agents)) |
| mem0 | LLM extracts facts and decides add / update / delete *(vendor benchmarks)* ([arXiv](https://arxiv.org/abs/2504.19413)) |
| Hindsight | Separate networks for world facts, experiences, entity summaries and beliefs; vector + BM25 + graph retrieval in parallel *(vendor)* ([arXiv](https://arxiv.org/abs/2512.12818)) |

What these share, and what plain vector RAG lacks:
- entity resolution;
- facts that carry a validity period;
- contradictions handled by superseding rather than overwriting;
- answers that need several hops through relationships.

All of them run their own graph store, which a Rocketflare app already has in its domain tables
(§10).

### 4.4 Cloudflare

**AI Search** (formerly AutoRAG) went GA on 1 October 2026
([changelog](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/)).
- **Retrieval:**
  - Vector and BM25 search run in parallel, fused with RRF or max, using a porter or trigram
    tokenizer ([hybrid](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/index.md)).
  - Optional `bge-reranker-base` reranking
    ([reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/index.md)).
  - Follow-up turns are rewritten from history
    ([rewriting](https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/index.md)).
- **Filtering:** `boost_by` on a timestamp or metadata field, with 5 custom metadata fields per
  instance.
- **Tenancy:** one instance per tenant through the `ai_search_namespaces` binding is the
  recommended model ([per-tenant](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/index.md)).
- **MCP:** every instance exposes an `/mcp` endpoint with a single `search` tool
  ([MCP](https://developers.cloudflare.com/ai-search/api/search/mcp/index.md)).
- **Pricing:** beyond the included allowance, $0.75 per 1,000 semantic queries and $0.75 per
  million ingestion tokens
  ([pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/index.md)).
  Cloudflare's own pages disagree on whether billing starts on 1 November or 1 December 2026.

**Agent Memory** (private beta, April 2026) is the most detailed retrieval design Cloudflare has
published ([post](https://blog.cloudflare.com/introducing-agent-memory)):
- **Retrieval:** five parallel channels (full-text, exact fact-key lookup, raw-message full-text,
  vector, HyDE vector), fused with weighted RRF.
- **Ingest:** content-hash ids make re-ingest idempotent, and a verifier pass checks each extracted
  memory against its source.
- **Replacement:** keyed facts are replaced through version chains.
- **Lessons they report:** no single channel won on every query, and dates are computed in code
  rather than by the model. Both bear on §10.

**Workers AI models.**
- `@cf/qwen/qwen3-embedding-0.6b` (1024 dimensions, 4,096-token input) is a drop-in candidate for
  our 1024-dimension column.
- `embeddinggemma-300m` accepts only 512 tokens, which is too short for our chunks.
- `bge-reranker-base` is the on-platform reranker; it returns raw scores, so a sigmoid gives 0–1
  ([catalog](https://developers.cloudflare.com/workers-ai/models/?tasks=Text+Embeddings)).

**Reference architectures.**
- **Ingestion pipeline:** Worker → Queues → Workers AI → Vectorize, with retries handled by the
  queue ([ref-arch](https://developers.cloudflare.com/reference-architecture/diagrams/ai/ai-rag/)).
- **Durable ingestion:** the RAG tutorial runs ingestion in a Workflow
  ([tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-retrieval-augmented-generation-ai/)).
- **Hyperdrive caching:** cached reads are not invalidated on write, so reading straight after a
  write wants an uncached config
  ([Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)).
- **Vectorize** caps at 1,536 dimensions and 10 metadata indexes
  ([limits](https://developers.cloudflare.com/vectorize/platform/limits/)).

### 4.5 Anthropic

**Contextual Retrieval** ([post](https://www.anthropic.com/news/contextual-retrieval)):
- **Method:** before indexing, prefix each chunk with 50–100 tokens of model-written context about
  where it sits in its document.
- **Results:** top-20 retrieval failures fell by 35% with contextual embeddings, 49% with
  contextual BM25 added, and 67% with reranking added (top 150 reranked down to 20).
- **Cost:** about $1 per million document tokens, one-off, because prompt caching loads each
  document once.
- **When to skip RAG:** below about 200,000 tokens, put the whole knowledge base in the prompt
  instead.

**API features relevant to retrieval:**
- **`search_result` content blocks** with `citations.enabled`
  ([docs](https://platform.claude.com/docs/en/build-with-claude/search-results)):
  - Claude cites individual blocks, so returning one chunk per text block gives chunk-level
    citations.
  - `cited_text` is not billed as output.
  - Citations cannot be combined with structured outputs on the same call.
- **The memory tool** (`memory_20250818`), **context editing** (`clear_tool_uses`, which removes
  stale retrieval results from long sessions) and **tool search**
  ([memory](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
  [context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)).
- **The Files API** is scoped to a workspace, not to an end user. Anthropic's advice for
  multi-tenant apps is one workspace per tenant, and never to accept a `file_id` from a client
  ([files](https://platform.claude.com/docs/en/build-with-claude/files)).

**Engineering guidance:**
- **Context engineering:** keep the "smallest possible set of high-signal tokens". Retrieve just in
  time through tools, and keep lightweight references instead of preloading content
  ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Why Claude Code dropped its vector index:** it moved to agentic search (grep and file reads)
  for freshness and simplicity. This comes from secondary accounts
  ([summary](https://smartscope.blog/en/ai-development/practices/rag-debate-agentic-search-code-exploration/)),
  and the argument is mainly about code, not business documents.
- **Writing tools for agents:** return readable names rather than ids, offer a concise/detailed
  `response_format`, and make empty or error results tell the agent what to try next
  ([tools](https://www.anthropic.com/engineering/writing-tools-for-agents)). Our tools already do
  most of this.
- **Claude Projects:** they switch to a knowledge-search tool only once the corpus nears the
  context limit ([help](https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects)).
  That is Anthropic's own default: put everything in context when it fits, and search when it
  doesn't.

### 4.6 Hosted knowledge products

What people now expect from a work knowledge base:
- Many connectors.
- Permissions copied from each source and applied before ranking.
- Citations to the exact passage.
- Visible freshness and sync status.
- Cards for people and entities.
- MCP access for other agents.

Products that show these:
- **Glean:** connectors that copy source permissions, plus an enterprise graph of people and
  projects ([docs](https://docs.glean.com/connectors/about)).
- **Notion Enterprise Search:** cites its sources and respects source permissions
  ([help](https://www.notion.com/help/notion-ai-connectors)).
- **OpenAI `file_search`** ([guide](https://developers.openai.com/api/docs/guides/retrieval.md))
  is a useful set of defaults:
  - 800-token chunks with 400 overlap;
  - RRF weights between embedding and text;
  - `score_threshold` and `rewrite_query`;
  - 16 attribute keys per file for filtering.

### 4.7 Techniques

- **Rerankers:** Cohere Rerank 4 (32K context), Voyage rerank-2.5, jina-reranker-v3, and bge on
  Workers AI.
- **Contextualised embeddings without an LLM call:** late chunking and `voyage-context-3`.
- **Smaller vectors:** Matryoshka truncation, `halfvec` (half the storage) and binary quantisation
  with rescoring (about 32× smaller; AWS reports a 367 GB index shrinking to 38 GB)
  ([AWS](https://aws.amazon.com/blogs/database/scale-pgvector-with-binary-quantization-on-amazon-aurora-postgresql/)).
- **Long context degrades retrieval.** Every model tested got worse as input grew
  ([Chroma](https://research.trychroma.com/context-rot)). The consensus is a bounded, precise
  retrieved set, not a large one.
- **Query decomposition** gives mixed results and hurt precision on some multi-hop benchmarks.
- **No ParadeDB on our deployed database.** Neon has deprecated ParadeDB's `pg_search`
  ([Neon](https://neon.com/docs/extensions/migrate-pg-search-to-lakebase-text)), and Neon is our
  deployed default (D35). So BM25-style lexical search should stay on native Postgres: a generated
  `tsvector` with a GIN index, and `pg_textsearch` only where the host offers it.
- **pgvector 0.8.2** fixes CVE-2026-3172 in parallel HNSW builds; check the version on each host.

## 5. Gaps by priority

Effort is S (days), M (a week or two) or L (more).

**Must have**

| Gap | Evidence | Effort |
|---|---|---|
| Retrieval evals: golden set, recall@k, MRR, context precision | `apps/evals/kit/judges.ts` has no retrieval metric; `knowledge-chat.jsonl` has 5 cases | M |
| Reranker | `retrieval.ts:15` names a `RerankFn` seam that does not exist | S |
| Stored lexical index | tsvector computed per query (`retrieval.ts:41`) | S |
| Model-consistent dense search + re-embed | tenant dense leg has no model filter (`retrieval.ts:273-279`) | M |
| Content-hash dedupe and incremental sync | dedupe only via `externalId` | S |
| Failed-document recovery | DLQ commented out (`wrangler.toml:147`); no retry route | S |
| Spend metering and caps | no `recordUsage` call in ingest or retrieval | S |
| Structure-aware chunks with heading path and page | `chunking.ts:73` splits on blank lines only | M |
| Entities and facts linked to domain rows | none | L |

**Should have**
- Contextual chunk prefixes.
- Rewriting of follow-up queries.
- `search_result` blocks for span-level citations on Anthropic models.
- Neighbour or parent-section expansion.
- A relevance threshold.
- Collections and tags as filters.
- A recency boost.
- Language-aware lexical search.
- A knowledge MCP server.
- CLI `docs` commands.
- An index-health admin page.
- Putting a small tenant's whole corpus in context.

**Could have**
- Answers to questions about a whole corpus (LazyGraphRAG).
- Background consolidation of facts.
- Late-interaction retrieval.
- Binary quantisation at scale.
- OCR and agentic parsing.
- Online evals on sampled traffic.

## 6. Developer experience, maintainability, operations

**Developer experience.**
- **Strengths:**
  - Contracts first (`packages/shared/src/ai/embeddings.ts`).
  - A plugin knowledge API that keeps plugins out of the internals.
  - Broad test coverage.
  - A working stack with zero credentials.
- **Weaknesses:**
  - Chunk size, k, fusion weights and text-search language are constants, not configuration.
  - The demo seed's deterministic vectors make dense search meaningless locally
    (`deterministic-embedding.ts`).
  - The CLI has no knowledge commands.
  - A developer who changes the chunker has nothing to tell them whether retrieval got better.

**Maintainability.**
- **Strengths:**
  - The subsystem is small, readable and owned.
  - The driver seam already proved it runs on both `postgres` and `neon`.
- **Risks:**
  - **Dimension change.** There is one 1024-dimension column, so changing dimensions is a
    migration.
  - **Scattered constants.** Retrieval constants live in both `packages/shared` and
    `services/ai`.
  - **Stale memory branch.** The D36 branch is 20 releases stale, and its migration number
    collides with one on `main`.
- **Build versus buy.** Depending on a framework would swap these risks for supply-chain and churn
  risk: Mastra ships weekly minors and has had a compromised package, and LangChain moved its
  retrievers to a legacy package.

**Operations.**
- **Strengths:** search and embedding spans reach `ai_spans` and OTLP.
- **Weaknesses:**
  - Inline ingest is untraced.
  - A document that fails three times stays failed, with no dead-letter queue and no retry
    button.
  - Spend is not metered, which matters more once extraction adds an LLM call to every ingest.
  - There are no index statistics, and HNSW parameters are untuned defaults.
  - There is no backfill tooling, and platform documents have no admin view.

## 7. Options

**A. Evolve in place (recommended).**
- Keeps permission enforcement in SQL, joins with domain tables, the driver seam and the
  zero-credential local stack.
- Every technique in §4 ports to Postgres.
- Most of all, it is the only option where a fact can point at the app's own customer row.

**B. Adopt Mastra RAG or Memory.** Rejected for core:
- Its PgVector store has no BM25.
- It would duplicate our tracing, evals and tenancy.
- It adds supply-chain and churn risk.

Its extractor and scorer patterns are worth borrowing.

**C. Cloudflare AI Search.**
- **Strengths:** a strong managed default with hybrid search, reranking and MCP built in, and a
  clean per-tenant deletion story.
- **Against it for core:**
  - Five metadata fields cannot express owner and group visibility.
  - Search becomes an external call that costs money per query.
  - Results cannot be joined to domain rows.

It suits a plugin (for example indexing a public website) and is useful as a benchmark baseline.

## 8. Gaps the docs do not list

These were found during the review and are not in `docs/CONCEPTS.md` §9. Each goes into the known
gaps, or is fixed, in the iteration below:
- The `RerankFn` seam exists only in comments (`retrieval.ts:15`, `services/ai/CLAUDE.md:93`).
- A tenant's dense search mixes vectors from different embedding models after a model change.
- There is no dead-letter queue, and no retry or reindex route for failed documents.
- Embedding calls are not written to `ai_usage`.
- Lexical search is English-only.
- The CLI has no knowledge commands.

## 9. Sources

Every source is linked where it is cited above. The main ones:
- **Mastra:** [1.0](https://mastra.ai/blog/announcing-mastra-1),
  [Observational Memory](https://mastra.ai/blog/observational-memory),
  [Extractors](https://mastra.ai/blog/introducing-memory-extractors).
- **LangChain:** [Indexing API](https://js.langchain.com/docs/how_to/indexing).
- **Graphiti:** [paper](https://arxiv.org/abs/2501.13956).
- **Cloudflare:** [AI Search GA](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/),
  [AI Search as an agent primitive](https://blog.cloudflare.com/ai-search-agent-primitive),
  [Agent Memory](https://blog.cloudflare.com/introducing-agent-memory).
- **Anthropic:** [Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval),
  [search results](https://platform.claude.com/docs/en/build-with-claude/search-results),
  [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
  [writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents).
- **OpenAI:** [file search](https://developers.openai.com/api/docs/guides/retrieval.md).
- **Chroma:** [context rot](https://research.trychroma.com/context-rot).

## 10. Decisions (agreed 2026-11-17)

1. **What the second brain is.** Documents are the evidence. The brain keeps typed entities and
   facts extracted from them, and those entities are the app's own domain rows. This is the
   advantage to build on.
2. **Who defines entities.** Apps and plugins register entity types: a table, an id, a label, and
   a zod schema of the facts to extract. The kit owns the facts and the links. A kit staging table
   holds entities the domain has no row for yet, until a person or agent promotes or merges them.
3. **What extraction may write without review.**
   - **Automatic:** new facts, and facts that agree with what we hold.
   - **Flagged for review:** conflicts, low-confidence facts and merges into domain rows.
   - **Never automatic:** writes to domain columns. Those take an explicit, approved action.
4. **Who reviews, for a non-technical audience.**
   - **Default reviewer:** the person who created the context.
   - **Integrations:** the person who connected the integration reviews what it brings in.
   - **Admins:** can always see and settle any item.
   - **How it appears:** doubt is shown where people already look ("Is this still right?" on a
     card or in an answer), not in a queue to work through.
5. **Review never blocks retrieval.**
   - **Labelled, not hidden:** unconfirmed and conflicting facts are used, and the answer says so,
     citing each side.
   - **Integration facts** count as weaker evidence than a person's own upload.
   - **No ageing:** a fact never confirms itself with time; a newer agreeing source can confirm it.
6. **Per-person memory is out of scope.** It is a separate topic and possibly a plugin. Every fact
   carries a visibility column from the start, so a later plugin can attach without a migration.
7. **Measurement.**
   - A synthetic small-business fixture with planted facts and contradictions is the benchmark.
   - It is **kit-only**: listed in `kitOnly`, never in a copy's demo seed.
8. **Order.** Measurement → the foundations facts depend on → facts and entities → the rest.
9. **Scope.** All of that lands in **one iteration**, planned in
   `docs/plans/knowledge-facts-iteration-1.md` (D43). The rest becomes GitHub issues grouped by
   theme.
