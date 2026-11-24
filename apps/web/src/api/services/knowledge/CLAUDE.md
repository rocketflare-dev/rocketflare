# Knowledge facts (D43)

Typed facts read from documents, attached to the app's rows or to staging entities. How it works
and why: `docs/CONCEPTS.md` §9 "Knowledge facts".

| File | What |
|---|---|
| `types.ts` · `registry.ts` · `entity-types.ts` · `resolve.ts` | `EntityTypeRegistration`, `knowledgeEntityTypes()` (app + plugin types, validated; a test registers fixture types with `overrideKnowledgeEntityTypesForTests`, never `vi.mock`), `APP_ENTITY_TYPES` (empty in the kit), `resolverFor` / `defaultEntityResolver` (which row IS this name — extraction, `lookup_facts`), `mentionFinderFor` / `defaultMentionFinder` (which rows does this QUERY name — the facts block; rows with facts only), `rowSearchFor` / `defaultRowSearch` (what a person typing finds — the Promote picker) |
| `enqueue.ts` | `enqueueKnowledgeExtraction` — flag + registered types, never throws (reached lazily from `ai/ingest.ts`) |
| `extract.ts` | `extractDocumentFacts(db, cfg, env, input, deps)` — the `knowledge.extract` job body; `deps.types` overrides the registry (the eval) |
| `entities.ts` | `resolveMention` — domain resolver → staging trigram → staging embedding → new staging entity; `chooseCandidate` and the thresholds; `findEntitiesByName` / `entitiesMentionedIn` for the readers (through the reader's scope) |
| `state.ts` | `decideFactState` — the state table, pure; reads a `JudgedPair` |
| `judge.ts` | `createKnowledgeJudge` / `knowledgeJudgeFor` — the decision-model questions (same entity? same value?) over `resolveDecisions`, prompt key `knowledge-decide` |
| `judgements.ts` | `knowledge_value_judgements`: `loadJudged` (→ `JudgedPair`), `storeJudgements`, `moveJudgements` (merge / promote) |
| `facts-sql.ts` | the SQL every reader shares: `restoredStateSql` / `restoredState` (what a fact returns to with no conflict), `visibleConflictsSql(scope)`, `entityVisibleSql(scope)`, `supersededOutOfViewSql(scope)` / `stateInViewSql(scope, states)` (a fact superseded only by a hidden one) |
| `facts-read.ts` | the reader's view: `selectFacts` (inner join `documents` + `visibleDocuments`), `readVisibleFact`, `getEntityCard`, `listReviewItems` |
| `review.ts` | `reviewFact` (confirm / reject / prefer), `mergeEntity`, `promoteEntity`, `keepEntitySeparate` (each nudges after commit), `promoteCandidates` (the picker), `recomputeKey` |
| `notify.ts` | `nudgeKnowledgeChange` (the two nudges) and the reviewer reads behind it: `reviewersOfFacts`, `reviewersOfEntity`, `reviewersOfDocument` |
| `lookup.ts` | `lookupFacts` (the `lookup_facts` tool) and `factsForQuery` (`search_knowledge`'s facts block) |
| `values.ts` · `dates.ts` · `quotes.ts` | value coercion against a key's schema · the date resolver · the verbatim-quote verifier — all pure |

## Rules

- **The model proposes, code decides.** The model returns candidates through ONE `submit_facts`
  tool call per section (`callStructuredTool`, prompt key `knowledge-extract`); everything after —
  the quote, the value, every date, the entity, the state — is decided here, in code, and a
  candidate that fails any of it is DROPPED, never repaired by a guess. A section's candidates are
  checked TOGETHER before any is written: two values for one entity and key over the same window
  are a misreading and both drop (`ambiguous`) — never "keep the first"
- **No string rules for meaning.** Whether "per call-out" is "per visit", "Marcus" is "Marcus
  Bell" or two service names are one service is a decision-model question (`judge.ts`), never a
  normaliser, alias list or language rule here. Code acts only on a confident answer
  (`JUDGE_MIN_PROBABILITY`); unsure, failed or absent keeps the literal rule. A closed set belongs
  in the type as a `z.enum`, a key naming another entity in `refs` (stored as `value_ref`, compared
  by `factCompareKey`, never judged as text)
- **Dates are resolved against the document's date** (`documents.created_at` — what an integration
  or the eval back-dates), never by the model: `resolveDatePhrase` answers an ISO day or `null`,
  and `null` drops the fact. UK numeric order, always. Unit tests in
  `tests/config/knowledge-extraction.test.ts` — extend them with every phrase you teach it
- **Nothing writes a domain column.** A fact about a domain row is a `knowledge_facts` row pointing
  at it (`entity_kind: 'domain'`); acting on it is a person's job
- **Re-extraction replaces** a document's facts first (`removeDocumentFacts`, which also unlinks
  them from the conflicts they caused) — so a redelivery or a re-index is idempotent. Deleting a
  document runs the same repair before the row goes (`deleteDocumentsWithFacts`) — never delete a
  `documents` row and leave its facts to the FK cascade
- **…except a person's decisions.** `removeDocumentFacts(…, { keepDecided: true })` keeps every
  fact with `confirmed_at` set or state `rejected`; a new reading with the same entity, key and
  value — or one stored as judged `same` (`matchDecided`, same validity preferred) — REUSES that row (`keepDecidedFact`: new citation,
  confidence, validity — never `state`, `confirmed_*` or `conflicts_with`). What the run did not
  re-read is deleted at the end unless a section failed. Never move this to memory: a retried run
  must still find the decisions (tests: `knowledge-extract.test.ts` "a person’s decision survives")
- **Nudge after the write, through `notify.ts`**: a review action (`review.ts`, `realtime?`
  trailing) and an extraction run that wrote or removed facts (`deps.realtime`; the job passes
  `collectingRealtime` and flushes) send `entity.changed { entity: 'knowledge' }` tenant-wide —
  the review list, entity pages, browse views — AND `knowledge-review-count` to the reviewers of
  the rows they touched, never tenant-wide: every member has the badge mounted, so a tenant-wide
  count nudge is a refetch per member per settle. Extraction reads the reviewers of the document
  and of its conflicts BEFORE removing the old reading and again after the new one
- **Tenant**: every query carries `tenant_id = input.tenantId`; a resolver or mention finder gets
  `{ access: fullAccessScope(tenantId) }` and must keep it; the Promote picker hands its search
  the READER's scope, so a resolver that honours visibility shows a row only to who may see it
- **Linking and searching are different questions.** The resolver must not let a part-name win
  ("Marcus" is not automatically "Marcus Bell" — that is the judge's call), so it scores
  `similarity`; the picker answers a person typing, so it also takes `word_similarity(q, label)`.
  Never reuse the picker's search to link a mention
- **Cost**: every call is a `knowledge.extraction` row (`recordKnowledgeUsage`), name embeddings
  `knowledge.embeddings`; `knowledgeExtractionAllowed` is checked before each document, and the
  cap re-enqueues the job for the next UTC day rather than failing it
- Preference between disagreeing facts is DERIVED (`isPreferredOver` / `preferredFact` in
  `@rocketflare/shared/ai/knowledge-facts`) — never a column
- **What a model is shown is what every reader of the document may see.** The extraction prompt's
  known entities and accepted facts, and the facts and held values a judge compares, come from
  TENANT-VISIBLE documents only (`promptScope` in `extract.ts`), and only a tenant-visible document
  adds aliases to an entity (`ResolveContext.documentVisibility`). States are still decided against
  every fact the tenant holds; the readers mask the rest
- **A fact is read through its document.** Every read joins `documents` and ANDs
  `visibleDocuments(scope)` — never read `knowledge_facts` alone for a person or a model. A hidden
  fact is a 404 (never a 403), a fact conflicting only with hidden ones reads as its restored
  state, and `conflicts_with` is filtered to visible ids (`visibleConflictsSql`); a fact superseded
  only by a hidden one reads as its restored state with no `supersededById`, and is answerable,
  current and reviewable for that reader (`stateInViewSql` wherever SQL filters on state). An action touches
  only the facts its reviewer can see — except `reject`, which unlinks the rejected fact everywhere
- **`prefer` rejects, it never supersedes**: superseded means true for an earlier window, and an
  `asOf` lookup and re-extraction would bring it back
- **Merge and promote re-decide shared keys** (`recomputeKey`, `decideFactState` replayed oldest
  first, a confirmed fact at confidence 1) — never copy states across
