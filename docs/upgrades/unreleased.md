---
version: unreleased
previous: 0.39.0
date: null
breaking: false
migrations: []
areas: [api, docs]
touches_surfaces: [feature-knowledge]
requires_surfaces: []
manual: false
---

## What changed

Knowledge facts respect document visibility when facts are built: extraction shows models only tenant-visible documents' facts and names, restricted documents add no entity aliases, and hidden supersessions and hidden-only entities stay out of a member's view.

- Extraction prompt and decision-model material (known entities, accepted facts, held values) come from tenant-visible documents only, whatever the document being read (`services/knowledge/extract.ts`, `promptScope`).
- `ResolveContext` gains a required `documentVisibility`; a `groups` document adds no aliases to the entity it links to or creates (`services/knowledge/entities.ts`).
- A fact superseded only by a fact the reader cannot see reads as its restored state with `supersededById: null`, and is answerable in `lookup_facts`, counted in `GET /api/knowledge/entities` and reviewable by that reader; `confirm` keeps the stored `superseded` state (`facts-sql.ts` `supersededOutOfViewSql` / `stateInViewSql`, `facts-read.ts`, `review.ts`).
- `findEntitiesByName` and `entitiesMentionedIn` take the reader's `AccessScope` instead of a tenant id and return only staging entities the reader may see, so `lookup_facts` answers an entity known only from hidden documents like an unknown name.
- Rationale: `docs/CONCEPTS.md` §9 "Knowledge facts" (extraction and "Reading facts").

## How to apply

1. Port the changes to `apps/web/src/api/services/knowledge/{extract,entities,facts-sql,facts-read,lookup,review}.ts`; the patch applies as-is unless an app edited those files.
2. In any app code that builds a `ResolveContext` for `planMention` / `resolveMention`, add `documentVisibility: 'tenant' | 'groups'` taken from the document the mention was read from.
3. In any app code that calls `findEntitiesByName(db, tenantId, …)` or `entitiesMentionedIn(db, tenantId, …)`, pass the reader's `AccessScope` (`accessScopeOf(auth)`, or `fullAccessScope(tenantId)` for a maintenance path) in place of the tenant id.
4. Copy the tests `apps/web/tests/api/security/knowledge-visibility-producer.test.ts` and `apps/web/tests/api/security/knowledge-visibility-readers.test.ts`.
5. No migration, no data backfill: aliases stored by an earlier release stay on their entities; remove any by hand that a restricted document contributed if that matters to the app.

## Conflicts to expect

- `apps/web/src/api/services/knowledge/entities.ts` → reader lookups take an `AccessScope` → update any app caller as in How to apply step 3.

## Verify

1. `pnpm typecheck` passes.
2. `pnpm web test:api` passes, including `tests/api/security/knowledge-visibility-producer.test.ts` and `tests/api/security/knowledge-visibility-readers.test.ts`.
