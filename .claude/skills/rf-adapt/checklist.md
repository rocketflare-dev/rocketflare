# Adapt — the rows that need a person

`scripts/rename.mjs` prints these as "Careful rows (a)–(f)" and fixes what is mechanical. Walk
them in order after the rename has run, then (g) — which the script does not print — when this app
has a plugin installed. Paths are repository-relative; `<slug>` / `<snake>` /
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
Expect `API_KEY_PREFIX = '<snake>_'` (separator included, never the hyphenated `<slug>`),
`API_KEY_PREFIX_LENGTH = <len(snake_) + 8>` and `REDACTED_KEY_CHARS = <len(snake_) + 4>`, with
the `(<n>) + 8` / `+ 4` comments matching.

**What to change.** Nothing if the values match. If the script reported it could not read a
constant, set both by hand to the values it printed; if it warned about `API_KEY_PREFIX`, set it
to `'<snake>_'`. Existing keys keep working — only the handle
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
grep -n "^name:\|container_name\|POSTGRES_\|-dev-data\|pg_isready" apps/web/docker-compose.dev.yml apps/web/docker-compose.test.yml
```
Expect `<slug>-dev-postgres`, `<slug>-test-postgres`, `<slug>-dev-data`, `name: <slug>-test` (the test
file's Compose project), `POSTGRES_USER: <snake>`,
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

**What to check.** The palette is `oklch()` on one hue (the kit's default, ember, is 35) in
`apps/web/src/shared/theme-tokens.css` and the two `[data-theme]` blocks of
`apps/web/src/ui/index.css`. With `--colour <#hex|hue>`, the script turned every one of those
literals to the colour's hue, keeping each lightness and chroma (which is what keeps contrast),
and set `<meta name="theme-color">` in `apps/web/src/ui/index.html` to the new light primary. The
flare (the logo's gold, in the sign-in drawing) and the state colours keep their own hue. It takes
only the HUE: an exact primary of the user's own lightness is a brand.css job. Without `--colour`,
the kit's ember (a warm rust at low chroma) is still there. The header comment block of `index.css`
("REBRANDING — change these and nothing else") lists every knob.

**How to check.**
```
grep -n "color-primary\|rail-surface\|series-1\|flare" apps/web/src/shared/theme-tokens.css apps/web/src/ui/index.css
pnpm web test:ui
```
Expect the new hue as each literal's third number (the flare unchanged), and
`tests/ui/contrast.test.ts` green (WCAG AA: text 4.5:1, controls, focus ring and chart series 3:1).

**From the design.** If `docs/design/brand.css` exists (the `rf-design` style step, signed off),
apply it instead of asking: `pnpm design:docs --apply-brand` writes each property into whichever of
`theme-tokens.css` and `index.css` defines it (a `--brand-hue` turns the whole palette first), plus
`<meta name="theme-color">`. A brand.css that names a new font also needs its
`@fontsource-variable/*` package added to `apps/web/package.json` and imported in
`apps/web/src/ui/main.tsx`. Then run `pnpm web test:ui`. Show the user `git diff --stat` and the
swatches from `docs/design/06-brand.md`. Skip `--colour` on the rename in that case, because the
brand already sets the hue.

**What to change.** Ask the user for their colour. The simplest answer is a hue: the rename has
already run, so write `@theme { --brand-hue: <n>; }` in `docs/design/brand.css` and run
`pnpm design:docs --apply-brand`. Re-run `pnpm web test:ui` after
every change; a failing contrast test names the token and the ratio.

## (f) Logo and the sign-in panel — report only

These are settings, not code: `[vars]` in `apps/web/wrangler.toml` and `wrangler.staging.toml`
(`.dev.vars` locally). They can change after the rename, per deployment, without a rebuild, so an
unsettled name or mark is no reason to postpone the rename.

**What to check.** The app still shows the kit's rocket until `APP_LOGO_URL` and `APP_FAVICON_URL`
are set. The script never sets them.

Beside them, the sign-in page's right-hand panel:
- **the image:** `LOGIN_PANEL_ART` — `rocket` is `apps/web/src/ui/components/LoginArt.tsx`, the
  kit's rocket as tonal linework. It takes its colours from the rail and flare tokens, so it
  already wears the new hue, but it is still the kit's picture; `type` shows the name and tagline;
- **the tagline:** `APP_TAGLINE`. The rename set it in both tomls from
  `docs/design/design.json` `app.tagline` when the design has one (the report says which);
  otherwise it is still the kit's neutral line.

**How to check.**
```
grep -n "APP_TAGLINE\|LOGIN_PANEL_ART\|APP_LOGO_URL\|APP_FAVICON_URL" apps/web/wrangler.toml apps/web/wrangler.staging.toml
curl -s http://localhost:3001/api/health
```
Open http://localhost:3000 once the app runs: the mark in the header and the browser tab, then sign
out to see the sign-in panel.

**What to change.** For the logo, put the user's files under `apps/web/src/ui/public/` (for
example `brand/logo.svg` and `brand/favicon.svg`) and set `APP_LOGO_URL = "/brand/logo.svg"` and
`APP_FAVICON_URL = "/brand/favicon.svg"` in both tomls, or point them at an `https://` URL. The
logo is shown as one image in both themes, so it must read on a light and a dark ground. For the
panel, do what `docs/design/06-brand.md` recorded, or ask: keep the rocket in their colours,
replace the SVG in `LoginArt.tsx` with imagery they own (colours from `currentColor` and the
`.login-art*` classes, so it follows the theme), or set `LOGIN_PANEL_ART = "type"` for the name
and tagline alone. Write `APP_TAGLINE` in their words if the rename did not. Locally the same
names go in `apps/web/.dev.vars`.

## (g) Installed plugins — translated on the way in, and again on the way forward

**What to check.** A plugin is a git repository copied into this app, and it is written in the
**kit's** vocabulary — `@rocketflare/shared`, `rocketflare_app`, the kit's own name in strings and
comments. `scripts/rename.mjs` walks every tracked file, so a plugin's three directories are
renamed exactly like core code; the dry-run table shows them as ordinary file rows under
`apps/web/src/plugins/<id>/`, not as a group of their own. What matters here is that it actually
reached them, because a missed import is a `typecheck` failure with a confusing message
(`Cannot find module '@rocketflare/shared/...'`) rather than an obvious rename bug.

The same is true **later**: `pnpm plugin add` and `pnpm plugin upgrade` run the identical
`applyReplacements()` translation on every file they copy in, reading the token map back out of
`.rocketflare.json`'s `app` block. So a plugin installed after the rename arrives already in this
app's names, and you never translate one by hand.

**How to check.**
```
pnpm plugin list
grep -rn "@rocketflare/\|rocketflare_" apps/web/src/plugins packages/shared/src/plugins apps/cli/src/plugins 2>/dev/null | head
pnpm plugin check
```
Expect: `No plugins installed.` (then there is nothing to do here), or one line per plugin and an
**empty** grep — every kit token translated — and `✔ n plugin(s) check out`.

**What to change.** Nothing, normally. A surviving `@rocketflare/…` import means the rename could
not see that file: fix it by hand, then `pnpm typecheck`. Never edit the six barrels
(`apps/web/src/plugins/{server,ui,schema,worker-exports}.ts`,
`packages/shared/src/plugins/index.ts`, `apps/cli/src/plugins/index.ts`) to make something pass — `pnpm plugin` writes those lines, and
`check` comparing them to the tree is what proves the install is real. If `check` reports a missing
migration for a plugin's tables, that is (b)'s fresh database, not a rename problem: `pnpm
db:generate --name plugin-<id>-<version>` then `pnpm db:migrate`.

## (h) Licence — whose app this is

**What to check.** The root `LICENSE` is still the kit's MIT notice, and every `package.json` says
`"license": "MIT"`. Left alone, the app's own code reads as MIT-licensed, with copyright in the kit
author's name. `LICENSES/kit-MIT.txt` holds the kit's notice, which the MIT licence requires the
app to keep.

**How to check.**
```
head -3 LICENSE; grep -n '"license"' package.json apps/*/package.json packages/*/package.json
cat docs/design/design.json 2>/dev/null | grep -A2 '"owner"'
```

**What to change.** Take the owner and licence from `design.json` `owner`, or ask: "Who owns this
app, by legal name, and may anyone else use its code?" Recommend all rights reserved.
- **All rights reserved:** write `LICENSE` as
  `Copyright (c) <year> <legal name>. All rights reserved.`, then a blank line, then
  `This app includes the Rocketflare starter kit, used under the MIT licence. Its notice is in
  LICENSES/kit-MIT.txt.`. Set every `package.json` `"license"` to `"UNLICENSED"` (npm's word for
  "not licensed to others").
- **An open licence:** write that licence's text with their name, add the same sentence about the
  kit, and set `"license"` to its SPDX id.

Never edit or delete `LICENSES/kit-MIT.txt`. `LICENSE` and `LICENSES/**` are on `neverPort`, so a
later `kit:upgrade` leaves both alone.

---

When all of them (seven, or eight with a plugin installed) are done: `pnpm gate`, commit, then update `docs/ADAPTING.md` §1 (or delete the table) so the next reader
knows the rename happened.
