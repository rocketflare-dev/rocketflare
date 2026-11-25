# Plan: harden "new site from an existing website" end to end

Status: agreed · 2026-11-13 · kit `feat/sites-launch-hardening`, plugin
`feat/sites-migrate-publish` (rocketflare-commercial-plugins)

## Why

Taking mosaicdata.ai from a fresh kit copy to a shared production site (`mosaic-sites-demo`) worked,
but only after a long list of manual fixes. A person following the skills would have stopped at
several of them. This plan turns every one into a kit or plugin change, adds what the demo showed
is missing (a site-wide favicon and share image), and makes the public site fast.

**Done means:** a fresh copy, the three sites skills and `/rf-provision` (production only) reach a
live, fast site with header, footer, published pages, a working contact form and a favicon, with
**no manual step outside the skills' own questions**. Proven by a second end-to-end run (§6).

## 1. What went wrong

| # | Stage | What happened | Owner | State |
|---|---|---|---|---|
| 1 | install | `plugin add` writes no `SITES_KV` / `SITES_MEDIA` / `IMAGES` blocks; media upload 503s until someone hand-writes them, with ids that later break provisioning | plugin + kit | open |
| 2 | install | the plugin's own test stops typechecking once those bindings exist (TS2783) | plugin | fixed on branch |
| 3 | install | `SITES_HOSTS` is never written for staging or production, so the site is dormant when deployed; nothing asks for the production host | kit provision + `sites-setup` | open |
| 4 | install | Node 24 on PATH: vitest dies with `code.charCodeAt is not a function` (Vite's source-map handler hides the real error) | kit | open |
| 5 | install | `pnpm test` in a copy fails while another checkout holds :5433, and the copy's database is never created | kit `scripts/test.mjs` | open |
| 6 | dev | "View live" and preview links point at Vite's port, which serves the admin for `*.localhost` | plugin | fixed on branch (Vite proxy `coreEdit`) |
| 7 | migrate | header and footer missing everywhere: drafts, regions unassigned, menus empty; the user pasted a header block into a page | plugin skills + CLI | fixed on branch (publish by default, `page publish`, `element publish`, regions) |
| 8 | dev | a changed block is invisible until something is published (render cache keyed only by publish generation); the same holds for a production deploy of new block code, for up to the page TTL | plugin + kit | open |
| 9 | design | copied header had no mobile menu; the hero painted over it once added | plugin `sites-copy-design` | fixed on branch (guidance) |
| 10 | design | bold text and links invisible in dark prose (daisyUI prose colours beat `prose-invert`) | plugin docs + starter blocks | open |
| 11 | site | no site-wide favicon or share (OG) image: every page view 404s `/favicon.ico` | plugin | open — §4.3 |
| 12 | forms | "contact form → summarise → email the admins" needed a hand-written core agent | app | won't do: apps write their own (decided) |
| 13 | provision | preflight fails late on a missing GitHub remote | kit | open |
| 14 | provision | `cloudflare <env>` re-declares plugin bindings in **both** tomls with placeholders; the second environment fails "already has id" and `--force` is not honoured there | kit | fixed in the copy, with a test; port |
| 15 | provision | R2 "bucket already exists" after a partial run is an error, not find-or-create | kit `cf-provision.sh` | open |
| 16 | provision | staging cannot be skipped (`all` always provisions it) | kit | open |
| 17 | provision | **`pnpm deploy` is pnpm's built-in command**: production deploys (and the documented root `pnpm deploy`) deploy nothing | kit | fixed in the copy; port |
| 18 | provision | Turnstile is required for forms in production but is not created or prompted for; `.provision.env.example` has no plugin-secret lines | kit + plugin | open |
| 19 | provision | **app and site as two Workers custom domains of one Worker**: Chrome reuses one host's connection for the other and Cloudflare answers a bare 403 before the Worker (no WAF event, no Worker log; incognito fine) | kit `urls` phase + plugin docs | fixed in the copy (zone routes + proxied DNS); port |
| 20 | content | `sites import` lands drafts, drops region assignments, and the export carries no redirects or site settings | plugin | open |
| 21 | CLI | relative paths resolve from `apps/cli`, not the caller's directory | kit CLI | open |
| 22 | CLI | `<APP>_API_KEY` / `<APP>_URL` silently override `cli login` | kit CLI | open |
| 23 | ops | `invocation_logs = false`: no per-request record to search by Ray ID | kit | open |
| 24 | perf | Neon region defaulted to `aws-us-east-1` for an Irish/UK site: ~1.8 s cache misses | kit provision | moved the demo to `aws-eu-west-2`; default open |
| 25 | perf | cache **hits** cost 0.4–0.6 s after idle: the publish generation is a KV read before every cache lookup, and a cold KV read goes to central storage | kit middleware + plugin | open — §4.4 |
| 26 | perf | a miss runs ~9 sequential queries (site, page, redirect, regions, elements, menus, targets, translations, media) | plugin | open — §4.4, superseded by §5 |

## 2. Constraint: the forms PR

`rocketflare-commercial-plugins` main checkout holds an uncommitted forms-library change (128 files,
~6,800 lines) touching the public router and render path, `public/index.ts`, `page.tsx`, the `sites`
schema, CLI `authoring.ts`, `rocketflare-plugin.json`, the README and `unreleased.md` — nearly every
file the plugin half of this plan touches. Therefore:

- **Kit work starts now** (no overlap).
- **Plugin work starts from the merged forms branch.** `feat/sites-migrate-publish` (items 2, 6, 7, 9)
  is rebased onto it then; nothing is written in the main checkout.

## 3. Kit — PR A (`feat/sites-launch-hardening`)

1. **Provisioning correctness** — port 14 and 17 with their tests; make R2 creation find-or-create (15);
   check the GitHub remote in preflight's first lines (13).
2. **Environments** — `--envs production|staging|both` on `all`; the default stays both (16).
3. **Region** — ask for the Neon region with the visitor geography spelled out, and stop defaulting to
   `aws-us-east-1` silently (24).
4. **Public-site hosts** — when an installed plugin declares `publicSites`, the `urls` phase writes the app
   and site hosts as zone routes (`{ pattern = "host/*", zone_name }`) and creates each host's proxied
   `AAAA 100::` record; it prompts for the site hosts and writes the hosts var (3, 19). Porting note for
   copies already on custom domains (the demo's commit `750de7c` is the recipe).
5. **Plugin secrets and Turnstile** — `.provision.env` gains the installed plugins' secret vars, blank;
   `secrets` names each skipped plugin secret and what breaks without it (18).
6. **Binding declarations at install** — `plugin add` writes plugin binding blocks with the placeholders
   provisioning expects, so local dev works and provisioning fills them (1).
7. **Generation memo** (kit owns the cache in `api/middleware/public-sites.ts`) — keep the last
   generation per isolate for a few seconds; on a stale memo serve the cached entry and refresh the
   generation in `waitUntil`. Publish stays visible within that window everywhere and immediately on
   the isolate that published (25).
8. **Deploy invalidates** — the build id joins the cache key, so new block code is never hidden behind
   the page TTL (8).
9. **Tests and CLI** — `scripts/test.mjs` reuses a running test server and creates the copy's database;
   `pnpm test` checks the Node version before vitest (4, 5); CLI resolves paths from the caller's
   cwd and says which credential source it uses (21, 22).
10. **Logs** — invocation logs on in both tomls, with the cost noted in `docs/DEPLOY.md` (23).

## 4. Plugin — PR B (after forms lands)

1. **Rebase** `feat/sites-migrate-publish` (2, 6, 7, 9).
2. **Setup** — `sites-setup` asks for production site hosts and Turnstile; README says routes, not custom
   domains, and why (3, 18, 19).
3. **Site-wide favicon and share image** (11), chosen from the site's media library:
   - `sites_sites` gains `favicon_media_id` and `og_image_media_id` (nullable, FK to `sites_media`,
     same tenant; the host generates the DDL).
   - API: `PATCH /api/sites/:siteId/settings` (publish permission), validated against the site's own
     library; CLI `sites settings <site> --favicon <media> --og-image <media>`.
   - Editor: a Site → Settings card with two media pickers (the existing picker), previews, and the
     sizes that will be served.
   - Serving: `<link rel="icon">` (32 px PNG variant), `apple-touch-icon` (180 px), and `/favicon.ico`
     answering a redirect to the 32 px variant, so the browser's default request stops 404ing. A
     page's own `og:image` wins; the site's is the fallback, also for `twitter:image`.
   - Changing either is a publish-level change: it bumps the generation.
   - Export/import carry both; `sites-copy-design` uploads the source's favicon and sets it.
4. **Export/import** — carry region assignments, redirects and site settings; `import --publish`
   publishes what it wrote (20).
5. **Render path** — run the independent queries in parallel (regions, menus, translations, media once
   the page is known) (26; interim until §5).
6. **Docs** — dark-prose classes in `CLAUDE.md` and the starter blocks (10); remove "no favicon" from the
   known gaps.

## 5. Plugin — PR C: published pages from R2 (design to agree first)

**Idea:** publishing renders the page once and stores the HTML in R2; visitors are served from R2 with
the edge cache in front; only previews and the editor read Neon. Visitors no longer depend on the
database at all — a slow or down Neon no longer takes the site with it.

- **Write path.** `publishPageLocale` enqueues `sites.render` for the page language; the job renders
  with today's code and writes `sites/<siteId>/<buildId>/<locale><path>.html` plus metadata (status,
  CSP additions, `Last-Modified`). Redirects, the sitemap and `robots.txt` are stored the same way.
- **Fan-out.** Publishing an element, region, menu or site setting re-renders every live page that uses it,
  found through `sites_element_uses` (and menus' page targets). Large sites: the job pages through
  uses in batches.
- **Read path.** Edge cache → R2 object → (missing) render from Neon, serve it, and write it back.
  No generation read on the hot path: the object key carries the build id, and a publish overwrites
  the object, so the cache key can be the object's etag.
- **Deploys.** A new build id means new keys; the first request for a page under a new build renders
  and writes it (or a post-deploy job warms every live page).
- **Stays dynamic.** Previews, form posts, the form-result page and anything per-visitor.
- **Open questions:** cost and time of fan-out on a large site; how stale a page may be while a fan-out
  runs; R2 vs Workers KV for small objects; whether the per-isolate memo (§3.7) is still needed.

**Decided: in scope.** It is the main lever on both speed and cost (no database work per visitor, and
Neon compute can scale to zero between edits). PR C follows PR B on the same post-forms base, with a
short design review of the open questions first; §3.7 and §4.5 stay as the interim and the fallback.

## 6. Proof run and targets

A second copy (`sites-proof`, on `sites-proof.clewro.com` + `sites-proof-admin.clewro.com`), the skills
and `/rf-provision` with `--envs production`; deleted afterwards. Re-running against `mosaic-sites-demo`
is the fallback if a second copy adds nothing. Any step that still needs a hand goes back into PR A or B.

| Measure (from London) | Now | Target |
|---|---|---|
| Cached page, warm | 70–150 ms | ≤ 100 ms |
| Cached page, after idle | 400–600 ms | ≤ 150 ms |
| Uncached page (DB render) | 0.2–0.8 s (London Neon) | ≤ 400 ms; ≤ 150 ms from R2 (PR C) |
| Manual fixes in the run | 20+ | 0 |

## 7. Decisions (2026-11-13)

1. **Starter lead agent:** no — a form's workflow stays app code.
2. **R2 published pages (PR C):** yes, in scope.
3. **Proof run:** `*.clewro.com`, or `mosaic-sites-demo` itself.
