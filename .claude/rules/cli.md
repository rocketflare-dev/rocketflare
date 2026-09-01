---
globs:
  - apps/cli/src/**
  - apps/cli/tests/**
---

# CLI Patterns (`apps/cli`, `@rocketflare/cli`, bin `rocketflare`)

A commander CLI that talks to the web API with a tenant API key. Dev: `pnpm cli <command>` from the
root (runs `tsx src/cli.ts` inside `apps/cli`); build: `pnpm --filter @rocketflare/cli build` → `dist/cli.js` (the `bin`).
The package is **private**; publishing it is an app decision (docs/DEPLOY.md).

## Shape

- `apps/cli/src/cli.ts` — `program` setup only: name/version from `package-info.ts`, global options
  (`--server <url>`, `--json`), one `.command()` per file, one catch that prints a `CliError` once and
  sets `process.exitCode`. No business logic
- `apps/cli/src/commands/<name>.ts` — one file per command, **thin**: options → `api.ts` → output.
  Each is an exported function taking a `CommandContext` (`context.ts`: config store, `fetch`, `open`,
  output — all injectable) so tests run it in-process without spawning
- `apps/cli/src/api.ts` — the only `fetch` call site (`createApiClient`). Adds `Authorization: Bearer
  <key>`, parses every response with the matching `@rocketflare/shared/<module>` schema (errors with the shared
  envelope), throws `CliApiError` with the exit code for the status. Never hand-write a response type
  here; add the schema to `packages/shared` first
- `apps/cli/src/errors.ts` — `CliError { exitCode, hint }`, `NotLoggedInError`, the `EXIT_*` constants.
  Commands throw; they never print errors or call `process.exit()`
- `apps/cli/src/config.ts` — `~/.rocketflare/config.json` (`ROCKETFLARE_CONFIG_DIR` relocates it; tests use a temp
  dir): directory `0700`, file `0600`, re-tightened on every write. Env overrides win over the file:
  `ROCKETFLARE_API_KEY`, `ROCKETFLARE_URL` (for CI — no browser); `ROCKETFLARE_DEBUG` enables debug lines
- `apps/cli/src/auth.ts` — the browser handoff: loopback `http.Server` on the first free port in
  `127.0.0.1:8765–8770`, `open(<server>/auth/cli?redirect_uri=http://127.0.0.1:<port>/callback)`,
  (plus `&hostname=<os.hostname()>` so the server can name the key `cli:<hostname>`), receive
  `?key=&tenant_id=&tenant_name=` once (an `?error=` query is handled defensively), answer a
  self-closing page, verify the key against `/api/me`, save, shut down. Five-minute timeout. Never
  log the key
- `apps/cli/src/utils/output.ts` — tables (`renderTable`), `formatJson`, pagination footer; `--json`
  switches the whole `Output` to JSON-only
- Never import from `apps/web`; only `@rocketflare/shared`, `commander`, `chalk`, `open`, `zod`, `node:*`

## Output

- Human output goes to stdout via `chalk`; diagnostics and progress to stderr. `--json` on **every
  list/read command** prints the parsed response as JSON only (no colour, no extra lines) so it pipes
  into `jq`
- **Never print a full API key.** Show `rocketflare_ab12…` (prefix + 4) in `whoami`/`status`/`keys list`;
  `login` says where the key was stored, not what it is
- Errors: one line `error: <message>` on stderr (+ `code` when the envelope has one). With `--json`,
  the envelope `{ error, statusCode, code? }` goes to stdout

## Exit codes

| Code | Constant | Meaning |
|---|---|---|
| 0 | `EXIT_OK` | success |
| 1 | `EXIT_ERROR` | API non-2xx other than 401/403, network failure, unexpected error. (Commander usage errors are not routed through `CliError`; `cli.ts` sets no `exitOverride`, so they take commander's default exit) |
| 2 | `EXIT_NOT_LOGGED_IN` | no key in config/env, or the server answered 401 (`hint`: run `rocketflare login`) |
| 3 | `EXIT_FORBIDDEN` | 403 — the key's role in the tenant does not allow the action |

`exitCodeForStatus(status)` in `api.ts` is the single mapping; `cli.ts` sets `process.exitCode`
from the thrown error, so tests assert the code without a process exit. `process.env` is legitimate
here (it is Node), but read it in `config.ts` only.

## Tests (`apps/cli/tests`)

Vitest, Node, no database (`.claude/rules/testing.md`). Build a `CommandContext` with a fake `fetch`,
a no-op `open`, a memory `Output` (`createMemoryOutput`) and a config store in a temp dir
(`ROCKETFLARE_CONFIG_DIR`); call the command function; assert the thrown `CliError.exitCode` and the parsed
`--json` output. Never touch the real `~/.rocketflare`.
