---
version: unreleased
previous: 0.37.0
date: null
breaking: false
migrations:
  - "knowledge_value_judgements (new table, tenant-isolated) + knowledge_facts.value_ref"
areas: [db, api, shared, ui, evals, docs, plugins]
touches_surfaces: [feature-knowledge, feature-evals]
requires_surfaces: []
manual: false
---

## What changed

Knowledge facts ask a decision model, rather than comparing text, whether two readings name one entity or state one value, and a fact key can name another entity (`refs`).

- A mention near known entities of its type is put to the decision model (TypeSafe, else the chat model on the new `knowledge-decide` prompt key); a confident pick links it.
- Two differing values for one entity and key are judged `same`, `more_specific` (compatible) or `different`; verdicts are stored in `knowledge_value_judgements` and read by every state decision.
- `EntityTypeDeclaration.refs` (`{ account_manager: 'person' }`): the value resolves to an entity, is stored as `knowledge_facts.value_ref`, and is returned as `valueEntity` on a fact and `names` on a fact hit.
- A person's decision carries over a re-read value judged the same as the decided one.
- `resolveDecisions` takes `fallbackPromptKey`.
- The agent-run timeline shows entity cards for `lookup_facts` and `search_knowledge`'s facts block; a run's `lookup_facts` summary keeps every entity.
- A section's ambiguous facts no longer leave an empty staging entity behind.
- The plugin API's `searchKnowledge` returns each hit's `rerankScore` and a `rerank` outcome (applied, model, reason).
- See `docs/CONCEPTS.md` §9 "Knowledge facts".

## How to apply

1. Run `pnpm db:migrate` to apply `0030_kit-knowledge-judgements-and-refs`.
2. In each registered entity type, turn any closed-set fact (units, frequencies, tiers) into a `z.enum` with a `.describe()` saying which wording means which value.
3. For each fact key whose value names a person or another registered entity, add `refs: { <key>: '<type>' }` to the type and register the target type.
4. Optionally pin a cheap model to the `knowledge-decide` prompt key in Settings → agent models.

## Conflicts to expect

- `apps/web/src/api/services/knowledge/entity-types.ts` → the doc comment shows `refs` and an enum → keep your own `APP_ENTITY_TYPES`, take the comment.

## Verify

1. `pnpm web test:api tests/api/knowledge-extract.test.ts` passes.
2. `psql "$DATABASE_URL" -c '\d knowledge_value_judgements'` shows the table.
3. `pnpm eval facts` reports false alarms at or below the 0.37.0 figure.
