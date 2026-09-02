---
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mjs"
  - "**/*.md"
---

# Code Quality

## Pre-commit gate (zero tolerance)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`typecheck` regenerates `apps/web/worker-configuration.d.ts` (`wrangler types`); commit the regenerated
file. CI fails on a dirty diff of it — a binding or var changed without the types following.

## Style (Biome 2, `biome.json`)

- Single quotes, `asNeeded` semicolons, 100 columns, 2-space indent, trailing commas `es5`
- `import type` / `export type` are errors when violated; unused variables and imports are errors
- `pnpm lint:fix` before manual fixes; `pnpm lint` (errors only) is what CI runs
- `apps/*/tests/**` and `apps/*/scripts/**` may use `any`; `src/**` in any package may not without a
  `// biome-ignore` line that states why

## TypeScript

- Strict, ES2022, bundler resolution, `noEmit` in `tsconfig.base.json`; each package extends it
  (`apps/web/tsconfig.json` covers its `src`, `tests`, `scripts`; `apps/cli`, `packages/shared` theirs).
  `pnpm typecheck` runs all three
- Alias `@/*` → `apps/web/src/*` (web only). Shared contracts are imported as `@rocketflare/shared/<module>`
  (workspace link, resolved to `packages/shared/src/<module>.ts` — TS source, no build). `packages/shared`
  imports nothing from `apps/web` or `apps/cli` — it must bundle for the browser; `apps/cli` never
  imports `apps/web`
- Bindings are typed by the generated `Cloudflare.Env`; do not hand-write an `Env` interface
- Infer types from zod schemas (`z.infer`) rather than duplicating interfaces

## Contracts first

New or changed API surface starts as a zod schema in `packages/shared/src/` (`@rocketflare/shared`), then
server validation, then the UI and the CLI parse the response with the same schema. The error envelope is `{ error, statusCode, code?,
details? }` (`packages/shared/src/errors.ts`) everywhere, including validation failures.

## Docs in sync (Non-Negotiable)

Changing behaviour changes the doc in the same PR:

| You changed | Update |
|---|---|
| a capability, a mode, a default | `docs/CONCEPTS.md` section + its "Known gaps" |
| a command, an env name, a setup step | `SETUP.md`, `apps/web/.dev.vars.example`, `README.md` commands; root `package.json` scripts if a new package script should be reachable from the root |
| a binding, a toml key, the release flow | `docs/DEPLOY.md`, both `wrangler*.toml` comments |
| a convention in a layer | the matching `.claude/rules/*.md` and `apps/web/src/<dir>/CLAUDE.md` / `packages/shared/CLAUDE.md` |
| a CLI command, flag or exit code | `docs/CONCEPTS.md` → CLI, `.claude/rules/cli.md` |
| a rename target | `docs/ADAPTING.md` |

A superseded doc is deleted in the same PR that supersedes it — git history is the archive. Never
leave a stale document sitting beside a current one.

## Secrets hygiene

- Secrets exist in `apps/web/.dev.vars` (git-ignored) locally and `wrangler secret put` in deployed envs.
  `[vars]` and `apps/web/.env.test` hold non-secrets and dummy values only. The CLI keeps its API key
  in `~/.rocketflare/config.json` (0600) — never in the repo, never printed in full
- **`.dev.vars` comments are not a safe place for alternate credentials.** A commented-out
  connection string is still a credential on disk read by every tool that opens the file. Keep
  other environments' strings in your password manager, not in the file
- `gitleaks` runs in CI over the full history. If it fires, rotate the credential first, then fix
  the history. `.gitleaks.toml` allowlists deterministic test fixtures only (path + regex,
  never a rule) — a real credential is never allowlisted
- Never log a connection string, token or key; `apps/web/scripts/cf-provision.sh` redacts them for that
  reason; the CLI prints key prefixes only
- Resource ids (Hyperdrive, KV) are not secrets and are committed in the tomls
