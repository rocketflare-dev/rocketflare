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

`typecheck` regenerates `worker-configuration.d.ts` (`wrangler types`); commit the regenerated file.
CI fails on a dirty diff of it — a binding or var changed without the types following.

## Style (Biome 2, `biome.json`)

- Single quotes, `asNeeded` semicolons, 100 columns, 2-space indent, trailing commas `es5`
- `import type` / `export type` are errors when violated; unused variables and imports are errors
- `pnpm lint:fix` before manual fixes; `pnpm lint` (errors only) is what CI runs
- `tests/**` and `scripts/**` may use `any`; `src/**` may not without a `// biome-ignore` line that
  states why

## TypeScript

- Strict, ES2022, bundler resolution, `noEmit`; one `tsconfig.json` covers `src`, `tests`, `scripts`
- Aliases `@/*` → `src/*`, `@shared/*` → `src/shared/*`. `src/shared` imports nothing from `src/api`,
  `src/db` or `src/ui` — it must bundle for the browser
- Bindings are typed by the generated `Cloudflare.Env`; do not hand-write an `Env` interface
- Infer types from zod schemas (`z.infer`) rather than duplicating interfaces

## Contracts first

New or changed API surface starts as a zod schema in `src/shared/`, then server validation, then the
UI parses the response with the same schema. The error envelope is `{ error, statusCode, code?,
details? }` (`src/shared/errors.ts`) everywhere, including validation failures.

## Docs in sync (Non-Negotiable)

Changing behaviour changes the doc in the same PR:

| You changed | Update |
|---|---|
| a capability, a mode, a default | `docs/CONCEPTS.md` section + its "Known gaps" |
| a command, an env name, a setup step | `SETUP.md`, `.dev.vars.example`, `README.md` commands |
| a binding, a toml key, the release flow | `docs/DEPLOY.md`, both `wrangler*.toml` comments |
| a convention in a layer | the matching `.claude/rules/*.md` and `src/<dir>/CLAUDE.md` |
| a rename target | `docs/ADAPTING.md` |

A superseded doc moves to `docs/archive/` with a row in its README — never deleted, never left stale.

## Secrets hygiene

- Secrets exist in `.dev.vars` (git-ignored) locally and `wrangler secret put` in deployed envs.
  `[vars]` and `.env.test` hold non-secrets and dummy values only
- **`.dev.vars` comments are not a safe place for alternate credentials.** A commented-out
  connection string is still a credential on disk read by every tool that opens the file. Keep
  other environments' strings in your password manager, not in the file
- `gitleaks` runs in CI over the full history. If it fires, rotate the credential first, then fix
  the history
- Never log a connection string, token or key; `cf-provision.sh` redacts them for that reason
- Resource ids (Hyperdrive, KV) are not secrets and are committed in the tomls
