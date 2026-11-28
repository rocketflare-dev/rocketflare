---
breaking: false
migrations: []
areas: [api, plugins, config, docs]
touches_surfaces: []
requires_surfaces: []
manual: true
---

## What changed

Tools gain two optional governance fields, `egress` and `readsContent`; a value check warns, in the gate and in `pnpm plugin check`, for every tool without `egress`, and a plugin route may now frame raster images.

- `Tool.egress?: boolean` answers "can this tool send your data outside your organisation — by email, a webhook, a web request, or by publishing a page?" for what the handler itself does. Calling the app's own embeddings, rerank or chat model is not egress.
- `Tool.readsContent?: boolean`: the tool returns organisation text a model reads (private and untrusted). Absent reads as `true`.
- Every kit tool answers both (`search_knowledge`, `get_document`, `list_documents`, `lookup_facts`, `list_example_notes`, and `research-topic`'s own tools).
- New `apps/web/src/api/services/agents/tools/egress.ts`: `readToolEgress(units)` calls each unit's `tools(ctx)` with a stub context (every flag on, every permission, no database) and reads the values, so an `as Tool` cast hides nothing. `installedToolUnits()` is the kit's list plus each installed plugin.
- New `apps/web/scripts/tool-egress.ts` prints that report as JSON; `pnpm plugin check` runs it and raises `<unit>:egress:<tool>` warnings (never failures), which the plugin matrix counts. Every `defineTool({ … })` call is also read statically, so a tool the builder did not return under the stub context (it queries the database, or is gated on a connection or a secret) still warns when it writes no `egress:` key; a plugin with a tool builder that showed no tool either way raises `<id>:egress-unverifiable` instead of counting zero. The report gains `units` (each unit's `builder` and `returned` count).
- `tests/config/tool-egress.test.ts` prints the same warnings in `pnpm gate` and never fails on them.
- `ctx.embeddable(contentType)` also admits `EMBEDDABLE_IMAGE_MIME_TYPES` (PNG, JPEG, GIF, WebP; never SVG), new in `@rocketflare/shared/files`. `/api/files/:id` still frames PDFs only.
- `.claude/rules/tools.md` and `docs/CONCEPTS.md` §9 describe both fields.

## How to apply

- Add `egress?` and `readsContent?` with their doc comments to `Tool` in `apps/web/src/api/services/ai/agent-loop.ts`.
- Take `apps/web/src/api/services/agents/tools/egress.ts`, `apps/web/scripts/tool-egress.ts`, `apps/web/tests/config/tool-egress.test.ts` and the `egress`/`readsContent` lines on the core tools as they are.
- Take `scripts/lib/plugin-lib.mjs` (`declaredToolEgress`, `declaresToolBuilder`, `egressProblems`), its `.d.mts`, and `scripts/plugin.mjs` (`readToolEgressReport` and the egress block after the tool-name check) as they are, if you have not changed them.
- Add `EMBEDDABLE_IMAGE_MIME_TYPES` / `isEmbeddableImageMimeType` to `packages/shared/src/files.ts`, and admit them in `embeddable` in `apps/web/src/plugins/api/http.ts` and in `makeRequestCtx` in `apps/web/tests/kit/unit.ts`.
- **Answer `egress` for your own tools now** — every tool you appended in `buildAgentTools`, in an app-owned plugin, or in an agent's own tool list. For each one, read what its handler does: `fetch`, email, a webhook or a publish means `true`; reading or writing this organisation's own records means `false`. Ask the person "can this tool send your data outside your organisation — by email, a webhook, a web request, or by publishing a page?" and confirm the list with them once. **Answer it, never default it to `false`.** Set `readsContent: false` only on a tool that returns no organisation text.
- A published plugin answers `egress` in its own release; until then its tools are warnings, not failures.

## Conflicts to expect

- `apps/web/src/api/services/agents/tools/*.ts` if you edited a core tool: keep your change and add the two lines after `schema`.

## Verify

- `pnpm test config apps/web/tests/config/tool-egress.test.ts` passes, and prints no `warn:` line once your own tools answer `egress`.
- `pnpm plugin check --json` lists a `<plugin>:egress:<tool>` warning for each installed plugin tool without `egress` — including tools its builder only returns once connected — and `ok` stays `true`.
- `pnpm gate` passes.
