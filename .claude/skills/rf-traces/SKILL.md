---
name: rf-traces
description: Debug an agent run, chat turn or AI job from its trace — the span tree of model calls, tool calls, retrieval and embeddings the kit records in Postgres — and coach the user through choosing or switching a tracing backend (local only, Langfuse, Phoenix, any OTLP endpoint). Use when a run failed or answered badly, a chat reply is wrong or slow, tokens look high, or someone asks how to see or export traces.
argument-hint: "[run id | trace id | message id | \"latest failure\"]"
---

# Traces — debug AI work from its span tree

Every agent run, chat turn and AI job (`chat.compact`, `document.index`, `document.convert`) is
recorded as OTLP spans (D32, `docs/CONCEPTS.md` §9). They **always** land in the tenant-scoped
`ai_spans` table, whether or not a backend is configured, so this works on a laptop with zero
credentials. An OTLP backend (Langfuse, Phoenix, …) receives the same spans on top. You read them
from the terminal; nothing here needs a vendor account.

**Read-only.** This skill diagnoses. It never edits code or config without the user saying yes to a
named change.

## 1. Find the trace

```
pnpm cli traces list [--agent <key>] [--status error] [--run <id>] [--conversation <id>] [--since <iso>] [--json]
pnpm cli traces show <traceId | runId | messageId> [--full] [--json]
```

- `$ARGUMENTS` is a run id (from the Agents page or `GET /api/agents/runs`) or a chat message id →
  `show` it directly; the server resolves either to its trace. A 32-hex id is already a trace id.
- "The latest failure" → `traces list --status error`, newest first; `--agent chat` for chat turns.
- `show … --json` is the whole span list (parse it with `jq` when the tree is large); `--full`
  prints tool and model content unclipped (default clip: 400 chars).
- **401** → `pnpm cli login`. **403 (exit 3)** → the key's role is below admin: `/api/traces` is
  `read Trace`, admin+ only, because spans hold other people's prompts. **404 `trace_not_found`** →
  nothing recorded yet (a run still `queued`), another tenant's id, or pruned — spans older than
  `OBSERVABILITY_SPAN_RETENTION_DAYS` (default 14) are deleted by the nightly `pruneAiSpans`.

## 2. Read the tree

```
invoke_agent research-topic   ERROR …            ← root: the run / turn / job, its input and output
  └ execute#0                                     ← one per Workflow step (runs only), retries included
    └ chat claude-sonnet-5  1200→340 tok  2.1s    ← one per model call: tokens in→out, finish reason
    └ execute_tool search_knowledge  0.4s         ← one per tool call: in: args · out: result
      └ retrieval search_chunks                   ← hybrid search: query in, hits (doc, seq, score) out
        └ embeddings @cf/baai/bge-m3              ← the query embedding
```

- Chat turns are `invoke_agent chat` with the generations and tools directly beneath (no step span).
  Jobs are `job <type>` roots (`job chat.compact`, `job document.index` → one `embeddings` per batch).
- **A run's root is recorded by the final `finish` step**, derived from the run id so each step's
  span already points at it. A tree of `execute#N` spans with no root above them is a run **still in
  flight** (or parked on a person) — not a bug. Several `execute#N` under one root are retries or
  resumes; the trace's status is the ROOT's, so a tool error inside a run that recovered is not a
  failed run.
- `content` absent everywhere (no `in:` / `out:` lines) means the deployment runs with
  `OBSERVABILITY_CAPTURE_CONTENT=false`: names, timings, tokens and statuses survive, prompts and tool
  I/O do not. Say so rather than guessing what was sent.

## 3. Triage, in this order

1. **The failing span.** The first `ERROR` in tree order is usually the cause; the root's message
   is the sentence the run stored. A provider error on a `chat <model>` span (rate limit,
   overloaded, bad credentials) is infrastructure — point at `resolveChat`'s tier (tenant config,
   platform key, Workers AI) rather than the agent.
2. **Tool arguments and results.** Read `in:` against the tool's schema (`services/agents/tools/`):
   a model passing strings for numbers, a wrong document id, an offset past the end. Read `out:`: a
   tool answering `{ error, hint }` is a dead end the model should act on — did the next generation
   act on it or call the same thing again?
3. **Empty or irrelevant retrieval.** `retrieval` output with zero hits, or hits from the wrong
   documents: the knowledge base is empty for this requester (D29 visibility applies), the documents
   are not `indexed`, or embeddings failed. Dense search always returns *something*, so check the
   titles, not just the count.
4. **Outliers.** Tokens-in growing turn over turn is the transcript growing (a tool result too big;
   `get_document` windows are the usual suspect). A slow `chat` span with few output tokens is the
   provider; a slow `execute_tool` is the database or an outbound call. Many turns ending in no
   terminal call is the loop cap (`AGENT_MAX_TURNS`) — the agent's salvage path should appear last.
5. **Report**: the span, what it shows (quote the args/result), the likely cause, and the file where
   the fix lives. Offer the change; do not make it unasked.

**Hand-off.** A failure worth keeping should become a regression case. The kit's eval harness
(`rf-evals`, issue 2) **is not built yet** — until it is, write the trace id, the input and the bad
output into the issue or the PR so the case can be added when it lands. Eval runs will be tagged
`rocketflare.eval=true`.

## 4. Coaching: where traces go

Tell the user plainly which of these they are on (`pnpm preflight` prints a `· tracing` line) and
what switching costs. All keys are in `apps/web/.dev.vars` locally; deployed, the non-secret ones go
in `[vars]` of **both** tomls (parity test) and the secrets through `wrangler secret put` or
`pnpm provision secrets <env>`.

| Backend | Set | Notes |
|---|---|---|
| **Local only** (default) | nothing | `ai_spans` + `pnpm cli traces`. 14 days' retention (`OBSERVABILITY_SPAN_RETENTION_DAYS`) |
| **Langfuse Cloud** | secrets `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | the `langfuse` preset is picked automatically: OTLP to `https://cloud.langfuse.com/api/public/otel`, Basic auth + `x-langfuse-ingestion-version: 4`. A pre-D32 deployment migrates with no new secret. Optional `OBSERVABILITY_TRACE_URL=https://cloud.langfuse.com/project/<id>/traces/{traceId}` makes `traces show` print a link |
| **Self-hosted Langfuse** | the two keys + `LANGFUSE_BASE_URL` (or `OTEL_EXPORTER_OTLP_ENDPOINT=<host>/api/public/otel`) | same preset |
| **Phoenix** | `OBSERVABILITY_PRESET=phoenix`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:6006` | locally: `docker run -p 6006:6006 arizephoenix/phoenix`, UI on :6006. Protobuf by default — Phoenix accepts only `application/x-protobuf`. Phoenix Cloud: its URL as the endpoint, and the auth header its docs give in `OTEL_EXPORTER_OTLP_HEADERS` |
| **Any OTLP/HTTP backend** | `OTEL_EXPORTER_OTLP_ENDPOINT` (+ secret `OTEL_EXPORTER_OTLP_HEADERS=k=v,k=v`, values URL-encoded) | JSON by default; `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` if it needs it. `/v1/traces` is appended |

- `OBSERVABILITY_CAPTURE_CONTENT=false` strips prompts, completions and tool I/O from the export
  **and** from `ai_spans` — the choice for tenants whose data must not leave the database or be kept.
- The backend is platform-wide; per-tenant backends are not built (`docs/CONCEPTS.md` §9 Known gaps).
- A backend that rejects spans never breaks a request: the export is swallowed and logged as
  `tracing: OTLP export returned a non-OK status` in the wrangler console — look there first when
  "nothing shows up", then check the endpoint and preset with `pnpm preflight`.
