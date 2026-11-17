# Knowledge facts (D43)

Typed facts read from documents, attached to the app's rows or to staging entities. How it works
and why: `docs/CONCEPTS.md` §9 "Knowledge facts"; decisions: `docs/plans/knowledge-base-review.md` §10.

| File | What |
|---|---|
| `types.ts` · `registry.ts` · `entity-types.ts` · `resolve.ts` | `EntityTypeRegistration`, `knowledgeEntityTypes()` (app + plugin types, validated), `APP_ENTITY_TYPES` (empty in the kit), `resolverFor` / `defaultEntityResolver` |
| `enqueue.ts` | `enqueueKnowledgeExtraction` — flag + registered types, never throws (reached lazily from `ai/ingest.ts`) |
| `extract.ts` | `extractDocumentFacts(db, cfg, env, input, deps)` — the `knowledge.extract` job body; `deps.types` overrides the registry (the eval) |
| `entities.ts` | `resolveMention` — domain resolver → staging trigram → staging embedding → new staging entity; `chooseCandidate` and the thresholds; `findEntitiesByName` / `entitiesMentionedIn` for the readers |
| `state.ts` | `decideFactState` — the state table, pure |
| `facts-sql.ts` | the SQL every reader shares: `restoredStateSql` / `restoredState` (what a fact returns to with no conflict), `visibleConflictsSql(scope)`, `entityVisibleSql(scope)` |
| `facts-read.ts` | the reader's view: `selectFacts` (inner join `documents` + `visibleDocuments`), `readVisibleFact`, `getEntityCard`, `listReviewItems` |
| `review.ts` | `reviewFact` (confirm / reject / prefer), `mergeEntity`, `promoteEntity`, `keepEntitySeparate`, `recomputeKey` |
| `lookup.ts` | `lookupFacts` (the `lookup_facts` tool) and `factsForQuery` (`search_knowledge`'s facts block) |
| `values.ts` · `dates.ts` · `quotes.ts` | value coercion against a key's schema · the date resolver · the verbatim-quote verifier — all pure |

## Rules

- **The model proposes, code decides.** The model returns candidates through ONE `submit_facts`
  tool call per section (`callStructuredTool`, prompt key `knowledge-extract`); everything after —
  the quote, the value, every date, the entity, the state — is decided here, in code, and a
  candidate that fails any of it is DROPPED, never repaired by a guess. A section's candidates are
  checked TOGETHER before any is written: two values for one entity and key over the same window
  are a misreading and both drop (`ambiguous`) — never "keep the first"
- **Dates are resolved against the document's date** (`documents.created_at` — what an integration
  or the eval back-dates), never by the model: `resolveDatePhrase` answers an ISO day or `null`,
  and `null` drops the fact. UK numeric order, always. Unit tests in
  `tests/config/knowledge-extraction.test.ts` — extend them with every phrase you teach it
- **Nothing writes a domain column.** A fact about a domain row is a `knowledge_facts` row pointing
  at it (`entity_kind: 'domain'`); acting on it is a person's job
- **Re-extraction replaces** a document's facts first (`removeDocumentFacts`, which also unlinks
  them from the conflicts they caused) — so a redelivery or a re-index is idempotent
- **Tenant**: every query carries `tenant_id = input.tenantId`; a resolver gets
  `{ access: fullAccessScope(tenantId) }` and must keep it
- **Cost**: every call is a `knowledge.extraction` row (`recordKnowledgeUsage`), name embeddings
  `knowledge.embeddings`; `knowledgeExtractionAllowed` is checked before each document, and the
  cap re-enqueues the job for the next UTC day rather than failing it
- Preference between disagreeing facts is DERIVED (`isPreferredOver` / `preferredFact` in
  `@rocketflare/shared/ai/knowledge-facts`) — never a column
- **A fact is read through its document.** Every read joins `documents` and ANDs
  `visibleDocuments(scope)` — never read `knowledge_facts` alone for a person or a model. A hidden
  fact is a 404 (never a 403), a fact conflicting only with hidden ones reads as its restored
  state, and `conflicts_with` is filtered to visible ids (`visibleConflictsSql`). An action touches
  only the facts its reviewer can see — except `reject`, which unlinks the rejected fact everywhere
- **`prefer` rejects, it never supersedes**: superseded means true for an earlier window, and an
  `asOf` lookup and re-extraction would bring it back
- **Merge and promote re-decide shared keys** (`recomputeKey`, `decideFactState` replayed oldest
  first, a confirmed fact at confidence 1) — never copy states across
