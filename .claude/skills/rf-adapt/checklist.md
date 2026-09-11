# Adapt — the six rows that need a person

`scripts/rename.mjs` prints these as "Careful rows (a)–(f)" and fixes what is mechanical. Walk
them in order after the rename has run. Paths are repository-relative; `<slug>` / `<snake>` /
`<UPPER>` are the names the script printed on its first line (`my-app` / `my_app` / `MY_APP`).

---

## (a) API-key display handles — usually done by the script

**What to check.** Keys are `<snake>_<43 chars>`. Two constants decide how many characters of a
key are shown in lists: `API_KEY_PREFIX_LENGTH` in `apps/web/src/api/utils/core/hash.ts` (the
server's stored handle, prefix + 8) and `REDACTED_KEY_CHARS` in `apps/cli/src/config.ts` (the
CLI's masked form, prefix + 4). If either is not longer than `<snake>_`, every listed key shows
zero characters of its token; the CLI tests assume exactly prefix + 4.

**How to check.**
```
grep -n "API_KEY_PREFIX\b\|API_KEY_PREFIX_LENGTH" apps/web/src/api/utils/core/hash.ts
grep -n "REDACTED_KEY_CHARS" apps/cli/src/config.ts
```
Expect `API_KEY_PREFIX = '<snake>'`, `API_KEY_PREFIX_LENGTH = <len(snake_) + 8>` and
`REDACTED_KEY_CHARS = <len(snake_) + 4>`, with the `(<n>) + 8` / `+ 4` comments matching.

**What to change.** Nothing if the numbers match. If the script reported it could not read a
constant, set both by hand to the values it printed. Existing keys keep working — only the handle
in lists changes.

## (b) The RLS role and the database — a decision, not a find/replace

**What to check.** `apps/web/migrations/*.sql` and `migrations/meta/*.json` now name the role
`<snake>_app` in every policy (`apps/web/src/db/schema/rls.ts` `APP_ROLE` matches). A database
that already ran the migrations under the OLD name keeps the old role and policies; the new
migration files will not re-apply to it. `EMBEDDING_DIM` (`packages/shared/src/ai/config.ts`,
1024) is a column type in the same migrations — a different embedding model with another width
must be chosen now, not after data exists (`docs/ADAPTING.md` §3).

**How to check.**
```
docker ps --format '{{.Names}}' | grep -- -postgres
docker volume ls --format '{{.Name}}' | grep -- -dev-data
grep -n "APP_ROLE" apps/web/src/db/schema/rls.ts
grep -c "<snake>_app" apps/web/migrations/0000_*.sql
```
Expect: no container or volume with the OLD kit name (only `<slug>-dev-postgres` /
`<slug>-dev-data` once you have run `pnpm dev:db:up`); `APP_ROLE = '<snake>_app'`; a non-zero count.

**What to change.** If the old container/volume exists, remove them — the renamed compose file
cannot: `docker rm -f <old>-dev-postgres && docker volume rm <old>-dev-data` (same for
`-test-postgres`). Then `pnpm dev:db:up && pnpm db:migrate` builds a fresh database under the new
names. Also `apps/web/.dev.vars` — the script renames its `DATABASE_URL` when the file exists;
confirm it reads `postgresql://<snake>:<snake>_pass@localhost:5432/<snake>_dev`. Decide the
embedding dimension now if you will not use the default `@cf/baai/bge-m3`.

## (c) Docker names — done by the script, confirm once

**What to check.** `container_name` and the volume in `apps/web/docker-compose.dev.yml` and
`docker-compose.test.yml` are pinned names; two checkouts of the same kit on one machine collide
on them. The Postgres owner is `<snake>` (never `<slug>` — `db-roles.ts` refuses a hyphenated
identifier), the databases `<snake>_dev` / `<snake>_test`.

**How to check.**
```
grep -n "container_name\|POSTGRES_\|-dev-data\|pg_isready" apps/web/docker-compose.dev.yml apps/web/docker-compose.test.yml
```
Expect `<slug>-dev-postgres`, `<slug>-test-postgres`, `<slug>-dev-data`, `POSTGRES_USER: <snake>`,
`POSTGRES_DB: <snake>_dev` / `<snake>_test`, and `pg_isready -U <snake> -d <snake>_dev`.

**What to change.** Nothing, normally. If you want a different owner or password, change the
compose file, `apps/web/.dev.vars.example`, `.dev.vars` and `.env.test` together.

## (d) Staging keeps its `-staging` suffix — the parity test proves it

**What to check.** Workflow, queue and R2 names are unique per Cloudflare account. Staging must
be `<slug>-staging`, `<slug>-jobs-staging`, `<slug>-agent-run-staging`, `<slug>-files-staging` in
`apps/web/wrangler.staging.toml`; production the same names without the suffix in
`apps/web/wrangler.toml`. `JOBS_QUEUE_NAME_PREFIX` in `apps/web/src/api/services/jobs.ts` must be
`<slug>-jobs` — the consumer matches the queue by that prefix.

**How to check.**
```
grep -n "^name = \|queue = \|bucket_name = \|^name = \"" apps/web/wrangler.toml apps/web/wrangler.staging.toml
grep -n "JOBS_QUEUE_NAME_PREFIX =" apps/web/src/api/services/jobs.ts
pnpm web test:config
```
Expect the names above and a green `tests/config/wrangler-parity.test.ts`.

**What to change.** Nothing unless the test fails; it names the key that drifted. Cloudflare
resources are created later (`SETUP.md` Part 3), with these names.

## (e) Brand colour — the user's choice

**What to check.** With `--colour`, the script rewrote the light theme's primary
(`--color-primary`, `--surface-active`, `--focus-ring`, `--dc-primary-rgb`) in
`apps/web/src/ui/index.css` and `<meta name="theme-color">` in `apps/web/src/ui/index.html`.
Without it, the kit's blue is still there. Either way the rest of the palette is untouched: the
dark theme's `--color-primary`, both `--color-primary-content` values (text on the accent), the
`--tone-primary-*` tints, `--color-accent`, and the neutral ramp. The header comment block of
`index.css` ("REBRANDING — change these and nothing else") lists every knob.

**How to check.**
```
grep -n "color-primary\|surface-active\|focus-ring\|dc-primary-rgb\|tone-primary" apps/web/src/ui/index.css
pnpm web test:ui
```
Expect the new hex where the script said, and `tests/ui/contrast.test.ts` green (WCAG AA: text
4.5:1, controls and focus ring 3:1).

**What to change.** Ask the user for their palette. Change the values in `index.css` only (the
`/* blue-600 */`-style comments beside them are now stale — update or drop them). Re-run
`pnpm web test:ui` after every change; a failing contrast test names the token and the ratio.

## (f) Logo — report only

**What to check.** `apps/web/src/ui/components/shared/LogoMark.tsx` (inline SVG paths),
`apps/web/src/ui/public/logo.svg` and `apps/web/src/ui/public/favicon.svg` still carry the kit's
rocket. The script never touches them.

**How to check.**
```
ls -la apps/web/src/ui/public/ apps/web/src/ui/components/shared/LogoMark.tsx
```
Open http://localhost:3000 once the app runs: the mark in the header and the browser tab.

**What to change.** Replace the `<path>`s in `LogoMark.tsx` (keep the `viewBox` and the
`className` prop) and the two svgs with the user's mark. A monochrome mark can use
`fill="currentColor"` with `className="text-primary"` to follow the theme.

---

When all six are done: `pnpm types && pnpm lint && pnpm typecheck && pnpm test`, commit, then
update `docs/ADAPTING.md` §1 (or delete the table) so the next reader knows the rename happened.
