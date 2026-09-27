---
name: example-feature
description: Exercise the example-feature reference plugin end to end — turn its flag on, create and list notes, fire the example-feature.ping smoke job through the queue, and follow a signed public ping link — or explain what each part demonstrates before deleting it. Use when someone asks to try, demo, smoke-test or understand the reference plugin, or to prove the queue or a public mount works locally.
---

# example-feature — exercising the reference plugin

`example-feature` is the plugin the kit ships to be READ and then DELETED (D31, decision 3). It is
a notes list that touches every slot a plugin can fill. This skill is also the reference for the
plugin skills slot itself: it lives at `.claude/skills/example-feature/` because the plugin's
manifest declares `"skills": ["example-feature"]`, and `pnpm plugin remove example-feature` deletes
it with the rest of the plugin.

The map of what demonstrates what is `apps/web/src/plugins/example-feature/CLAUDE.md` — read it
first, and answer "what does X show?" from it rather than from memory.

## Before anything: the dev server and a session

1. `pnpm dev:status` — if nothing is listening on :3001 and :3000, run `pnpm dev` in the
   background (it keeps running) and wait for both ports.
2. `pnpm cli whoami` — if it is not signed in, the human runs
   `pnpm cli login --server http://localhost:3001` (a browser opens). Do not try to do this for
   them.

## 1. Turn the flag on

The plugin's flag `example-feature` defaults **off**, and the mount answers 404
`feature_disabled` until it is on. Check with `pnpm cli features list`.

To turn it on, a global admin opens <http://localhost:3000/admin/feature-flags> and sets
**Example feature** to on (or to a rollout that includes the tenant). `pnpm seed --demo` sets it to
50 % tenant rollout, which may or may not include yours. Re-run `pnpm cli features list` to confirm.

## 2. Notes — the CRUD shape and the tenant predicate

- In the app: <http://localhost:3000/example-feature> (the nav item appears only with the flag on).
- From the CLI: `pnpm cli example-feature notes list`.

A new organisation gets one welcome note from the `onTenantCreated` hook. Members may read and
create; editing and deleting other people's notes is admin-level (`ExampleNote` grants).

## 3. The smoke job — producer → queue → consumer

`pnpm cli example-feature ping` calls `POST /api/example-feature/ping`, which ENQUEUES
`example-feature.ping` and answers 202 with the job id. The proof is in the `pnpm dev` output: a log
line `example-feature.ping: pong` with the tenant id. No line → the queue consumer is not running;
check `pnpm dev` started wrangler cleanly.

## 4. The public mount — a signed link with no session (D34)

`POST /api/example-feature/ping-link` (signed in) mints a URL under
`/api/hooks/example-feature/ping?state=…`, valid for a few minutes. Opening it needs NO session: the
handler verifies the signed state, re-checks the flag for the tenant the state names, and enqueues
the same ping. It is the shape every consent callback and webhook in a plugin follows. A tampered or
expired link answers 401; with the flag off, 404.

## 5. Deleting it

`pnpm plugin remove example-feature` shows the plan; `--apply` deletes its directories (this skill
included), its barrel lines and its surface. Then `pnpm db:generate` emits `DROP TABLE
"example_notes"` — read it before `pnpm db:migrate` — and run the gate. Stop and ask before `--apply`:
it is the human's decision.
