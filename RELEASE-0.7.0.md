# Finishing 0.7.0 — the remaining API gap, the release, and the cleanup

**Transient. Delete this file in the last cleanup step.** It exists so a fresh session can finish
0.7.0 without reconstructing today's context.

## Where things stand

| | |
|---|---|
| kit `main` | CI green on all four jobs, incl. *Gate with default plugins* |
| `.rocketflare.json` | `kit.version 0.6.1`, `kit.pluginApi {current:1, minSupported:1}` |
| `docs/upgrades/unreleased.md` | `previous: 0.6.1`, **10 entries** — the whole of 0.7.0 |
| `defaultPlugins` | still the OLD repo, `rocketflare-plugin-analytics@1.0.2` |
| `rocketflare-plugins` | `main` `1e4ce07`, branch `contract-migration` `6c2e90b`, **0 tags** |
| `rocketflare-plugin-analytics` | not archived, tags 1.0.0/1.0.1/1.0.2 intact |
| open issue | #19 — parse with the TS AST instead of matching strings |

`contract-migration` is analytics fully migrated onto the contract and verified against a `main`
clone: `plugin check` clean with two plugins, 1132 web tests, `cube-isolation` 7/7 across two
tenants, main UI bundle free of recharts/drizzle-cube/react-grid-layout.

---

# Part 1 — Publish the visibility helpers (and three smaller gaps)

## The problem

A plugin that registers a restrictable resource (`ServerPlugin.visibilityResources`) **cannot write
one**. Three functions are on no declared entry:

- `grantsForResources` — batch-read group grants for a set of rows
- `setResourceGroups` — write visibility + grants through the registry
- `resolveRequestedVisibility` — validate a requested visibility against the caller's own groups

Analytics had to reimplement all three (`plugins/analytics/services/visibility.ts`), preserving two
rules it would be easy to lose: **grant ids are tenant-checked**, and a member sharing outside their
own groups gets **403 `group_not_yours`**.

## Why they cannot simply be exported

They dispatch through `VISIBILITY_RESOURCES`, which reads the plugin barrel — composition is their
entire purpose. So `plugins/api/access.ts` importing `api/services/access.ts` recreates the exact
cycle fixed in `037d082`:

```
plugins/api -> ./access -> api/services/access -> plugins/server -> <plugin>/index -> plugins/api
```

With a second plugin installed that throws `createRouter is not a function` at import. **Test any fix
with two plugins; one plugin never shows this class of bug**, because the barrel re-enters a module
already in progress and is never re-executed.

## The rule this falls under

The kit's own principle, now stated in CONCEPTS §16: *a value a plugin needs from a composing module
moves to a LEAF; anything that cannot move is INJECTED.* `accessScopeOf` could move (it composes
nothing). These three cannot — so they are injected.

## Recommended approach

Add them as methods on `RequestCtx`, in `apps/web/src/plugins/api/http.ts`:

```ts
ctx.visibility.grantsFor(rows)          // -> grants per row
ctx.visibility.set(resourceKey, id, v)  // -> writes visibility + grants via the registry
ctx.visibility.resolve(body)            // -> validated, or throws 403 group_not_yours
```

**The implementation must not import `api/services/access` at module scope.** Use a function-scope
`await import(...)` inside each method — all three are already async, so this costs nothing and
confines the laziness to one adapter file rather than changing a core service's contract.

Two alternatives considered, and why they are worse:

- **A separate `plugins/api/visibility.ts` a plugin imports.** Fails: the plugin's own
  module-scope `import` reintroduces the cycle. The import statement is the problem, not when it
  is called.
- **Make `services/access.ts` read the barrel lazily.** Structurally cleanest, and worth doing if
  this recurs — but it changes a core module's shape for one consumer, and `visibilityResources()`
  is already a function for related reasons.

Additions are free under `PLUGIN_API`, so **no version bump** — but regenerate and commit
`docs/plugin-api.md` (`node scripts/plugin-api-doc.mjs`) or the gate fails naming the member.

## Fold in three smaller gaps from the same family

1. **`group_members` is not on `@/db/schema/kit`** — analytics reads it through `allTables()` inside
   a hook. Same one-line fix as `activityEvents`/`tenantUsers`/`groupTypes` in `037d082`'s
   predecessor.
2. **No group TYPE names on the auth context.** `AccessScope` carries ids only; analytics resolves
   type names with one query per cube request.
3. **`@testkit` publishes no cron dispatcher**, so a plugin can no longer prove its task and its toml
   expression meet — only that the task runs.

## How to verify (the only proof that counts)

```bash
git clone --branch main https://github.com/rocketflare-dev/rocketflare.git /tmp/kit-check
cd /tmp/kit-check && pnpm install
printf 'DATABASE_URL=postgresql://test:test@localhost:5544/rocketflare_test\n' > apps/web/.dev.vars
pnpm plugin add <path-to>/rocketflare-plugins --subdir plugins/analytics --apply --local
pnpm db:generate --name plugin-analytics-check && pnpm db:migrate:ci
pnpm plugin check && pnpm typecheck && pnpm test && pnpm build
```

Use a **dedicated Postgres**, not the shared `:5433` — another checkout's `db:migrate:ci` leaves its
tables behind and `rls-coverage` then fails with a live-vs-declared count mismatch that reads exactly
like a code defect. If you must reset `:5433`, only
`docker compose -f apps/web/docker-compose.test.yml down -v` works: `DROP SCHEMA public CASCADE`
leaves the `drizzle` migrations journal, after which migrate no-ops and every run dies with
`relation "users" does not exist`.

Then delete analytics' `services/visibility.ts` reimplementation and re-run the above — that is what
proves the published helpers are equivalent.

---

# Part 2 — The release

**Order matters and is not negotiable**: analytics 2.0.0 declares `requires.kit >=0.7.0 <1.0.0`, so
the kit must be tagged first or the plugin's range names a version that does not exist.

Cutting 0.7.0 with `defaultPlugins` still on the old repo is correct: analytics 1.0.2 declares
`requires.kit >=0.6.1 <1.0.0` (admits 0.7.0) and no `requires.pluginApi` (so it is warned, never
failed). CI on `main` proves this combination today.

### 1. Kit 0.7.0

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # all four exit 0 — check the CODES, not the log
node scripts/release.mjs 0.7.0 --dry-run                 # must pass WITHOUT --skip-plugin-check
pnpm kit:release 0.7.0                                   # writes docs/upgrades/0.7.0.md from unreleased.md,
                                                          # resets unreleased, CHANGELOG, package.json,
                                                          # .rocketflare.json kit.version
git add -A && git commit -m "Release 0.7.0" && git push origin main
git tag 0.7.0 && git push origin 0.7.0
gh release create 0.7.0 --title 0.7.0 --generate-notes
```

The tag runs `release-check --tag`, which requires the note, the CHANGELOG section and matching
version stamps. `deploy.yml`'s guard skips the deploy jobs for the kit itself, which keeps its
`<PLACEHOLDER>` toml ids on purpose.

### 2. `rocketflare-plugins` 2.0.0

```bash
gh pr create -R rocketflare-dev/rocketflare-plugins --base main --head contract-migration \
  --title "Migrate analytics onto the 0.7.0 plugin contract" --fill
# merge it, then on main:
node scripts/release.mjs 2.0.0 --plugin plugins/analytics
git add -A && git commit -m "Release 2.0.0" && git push origin main
git tag 2.0.0 && git push origin 2.0.0
gh release create 2.0.0 --title 2.0.0 --generate-notes
```

Lockstep: the root `package.json` and every `rocketflare-plugin.json` carry the one repo version.
Plain `X.Y.Z` tags, no prefixes — `git ls-remote` cannot resolve a bare SHA and `latestTag()` is how
`--to` and `openSource` default.

### 3. Repoint `defaultPlugins`

```json
{ "id": "analytics",
  "repo": "https://github.com/rocketflare-dev/rocketflare-plugins.git",
  "ref": "2.0.0",
  "subdir": "plugins/analytics" }
```

Then `pnpm plugin check` and the full gate. **No porting note is needed** — `.rocketflare.json` is a
root file and `behaviourFiles()` gates only `apps/**` and `packages/**` (verified). Push to `main`
and confirm CI's *Gate with default plugins* job goes green installing from the new repo and subdir.

**An existing install cannot `plugin upgrade` across this move** — `source.repo` is recorded per
surface, so it is `plugin remove` + `plugin add`. That is already in the 0.7.0 porting note.

### 4. Archive the old repo

Add a pointer to its README first, then:

```bash
gh repo archive rocketflare-dev/rocketflare-plugin-analytics
```

Its 1.0.x tags stay resolvable for anyone pinned to them.

---

# Part 3 — Cleanup

```bash
# all three confirmed merged into main
git push origin --delete agui-protocol feature-flags plugin-contract
git worktree list            # expect only the main checkout
git branch -a                # expect main (+ remotes)
rm RELEASE-0.7.0.md && git commit -am "Remove the 0.7.0 release runbook"
```

In `rocketflare-plugins`, delete `contract-migration` once merged.

## Carry forward

- **Issue #19** — convert the `.mjs` structural checks from string matching to the TypeScript AST.
  Three checks silently matched substrings, one of them pre-existing kit code, and the docs
  separately claimed TS2308 would catch duplicate plugin table names, which it does not.
- Four contract gaps above, all found by migrating a real plugin rather than by the reference one.
- `docs/plugin-api.md` is generated and diff-checked: change a member and the gate fails naming it;
  additions are free.
