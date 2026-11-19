---
version: unreleased
previous: 0.39.0
date: null
breaking: false
migrations: []
areas: [docs, config]
touches_surfaces: []
requires_surfaces: []
manual: false
---

## What changed

Public security reports now carry counts only: `audit.mjs public-report` renders runs and fixed counts by release and severity, and refuses any field describing an individual issue.

- `public-report`'s entries file is `{ repos, runs[{ date, commit, scope, coverage_units, agent_calls, confirmed: { high, medium, low }, fixed_in: [release] }], fixed[{ release, repo, high, medium, low, hardening }], contact? }`; `critical` is an optional count.
- The `findings` and `hardening` lists and every `line` are gone; `line`, `title`, `description` or any unknown field refuses the whole file, as do a count with no fixing release, a negative or fractional count, or a repo not in `repos`.
- `report.md`/`report.json` carry a fixed sentence: individual issues are not published, "Please request the detailed report by emailing <contact>" (default `security@rocketflare.dev`).
- `SKILL.md` "Public report", `docs/SECURITY-AUDIT.md`, `docs/CONCEPTS.md` (rf-security) and `SECURITY.md` state that only counts are ever published.

## How to apply

1. Take the kit's `.claude/skills/rf-security/tools/audit.mjs` (the `public-report` section: `PUBLIC_FIELDS`, `publicReportProblems`, `publicReport`) and `apps/web/tests/config/rf-security/public-report.test.ts`.
2. Take the "Public report" section of `.claude/skills/rf-security/SKILL.md` and the "Publishing a report" section of `docs/SECURITY-AUDIT.md`.
3. Set `"contact"` in your entries file to your own security address; without it the report names `security@rocketflare.dev`, the kit's.
4. Rewrite any existing entries file in the new shape: per run, the confirmed counts by severity and the releases that fixed them; one `fixed` entry per repository and release with its counts by severity and its hardening count. Drop every `line`.

## Conflicts to expect

- `SECURITY.md` → its audit paragraph now says only counts are published → keep your own wording and links, but do not promise per-finding publication.

## Verify

1. `pnpm web exec vitest run --project config tests/config/rf-security/public-report.test.ts` passes.
2. `node .claude/skills/rf-security/tools/audit.mjs public-report <entries.json>` on a file with a `line` field prints `REFUSED` and `nothing written`, and exits 1.
