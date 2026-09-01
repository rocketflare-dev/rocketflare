# @rocketflare/cli

Command-line interface for the Rocketflare kit server. Signs in through the browser (D26 handoff), stores
an API key under `~/.rocketflare/`, and exposes a few tenant-scoped commands as the pattern to copy.

```bash
pnpm cli --help                 # from the repo root (runs src/cli.ts with tsx)
pnpm cli login                  # browser → API key
pnpm cli whoami
pnpm cli status                 # GET /api/health on the configured server
pnpm cli members list --page 1 --page-size 25
pnpm cli keys list
pnpm cli activity list --type member.invited      # admin+
pnpm cli config get | set <key> <value> | path
pnpm cli --json members list    # raw JSON on stdout, nothing else
```

Global options: `--server <url>` (overrides everything below), `--json` (print the server's raw JSON
body to stdout; status lines still go to stderr).

Exit codes: `0` ok · `1` error (network, 4xx/5xx, bad usage) · `2` not logged in / 401 · `3` 403.

## Config file

`~/.rocketflare/config.json` — directory `0700`, file `0600`, written by `login`:

```json
{
  "serverUrl": "http://localhost:3001",
  "apiKey": "rocketflare_…",
  "tenantId": "uuid",
  "tenantName": "Acme",
  "user": { "email": "alice@example.com", "name": "Alice" }
}
```

`config get` and `whoami` print the key **redacted** (first 8 characters); nothing ever prints it in
full. `logout` removes `apiKey`, `tenantId`, `tenantName`, `user` and keeps `serverUrl`.

### Environment variables (CI)

| Variable          | Effect                                                                 |
| ----------------- | ---------------------------------------------------------------------- |
| `ROCKETFLARE_API_KEY`    | Use this key instead of the config file's                              |
| `ROCKETFLARE_URL`        | Server URL (below `--server`, above the config file)                   |
| `ROCKETFLARE_CONFIG_DIR` | Directory of `config.json` (default `$HOME/.rocketflare`) — tests use this    |
| `ROCKETFLARE_DEBUG`      | Print debug lines and stack traces to stderr                           |

Precedence: `--server` flag > `ROCKETFLARE_URL` > config `serverUrl` > `DEFAULT_SERVER_URL`
(`http://localhost:3001`, the kit's `wrangler dev` port — a real app sets its production URL in
`src/config.ts`). Key: `ROCKETFLARE_API_KEY` > config `apiKey`.

**ADAPTING** renames the bin (`package.json` → `bin`), the env prefix and directory (`ENV_PREFIX`,
`CONFIG_DIR_NAME` in `src/config.ts`). The prompt prefix and `User-Agent` follow the bin name.

## How the login handoff works

1. `rocketflare login` starts a loopback HTTP server on `127.0.0.1`, first free port in **8765–8770**, and
   listens on `/callback`.
2. It opens the browser at `${serverUrl}/auth/cli?redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Fcallback`.
3. The server has the user sign in and pick a tenant, mints a tenant API key (named `cli:<hostname>`
   server-side) and redirects to the callback with
   `?key=<api key>&tenant_id=<uuid>&tenant_name=<name>` — or `?error=<code>` on failure.
4. The callback page replies with a tiny self-closing "You can return to the terminal" HTML page
   (`400` for errors or missing `key`/`tenant_id`, `404` for other paths).
5. The CLI calls `GET /api/me` with `Authorization: Bearer <key>` to learn the user's email/name
   (a 401 fails the login; a missing route only warns), writes the config, and prints the key prefix.
6. Nothing arrives within **5 minutes** → the command fails with exit `1`.

`whoami` uses `GET /api/me` → the flat `meResponseSchema` user (with `preferences`) and `GET /api/tenant` → tenant (both parsed tolerantly with
the `@rocketflare/shared` schemas' `.partial()`); a forbidden/missing `/api/tenant` falls back to the stored
tenant name.

## Adding a command

1. Create `src/commands/<thing>.ts` exporting `run<Thing>(ctx: CommandContext, options)`. Get a client
   with `requireClient(ctx)` (throws `NotLoggedInError` → exit 2) or `publicClient(ctx)`.
2. Call `client.request('GET', '/api/<thing>', { schema, query })` with the zod contract imported from
   `@rocketflare/shared/<module>` — always the subpath, never the barrel. `request` returns `{ raw, data }`.
3. Print with `ctx.out.data(raw, () => renderTable(data.items, columns))`; footers/status via
   `ctx.out.text()` / `ctx.log.*` (stderr).
4. Register it in `src/cli.ts` with `action(...)` — that wrapper builds the context from the global
   options, and maps thrown errors to exit codes. Commands never call `process.exit`.
5. Test it in `tests/commands.test.ts` with `mockFetch` + `testContext` (see `helpers.ts`).

## Build

`pnpm --filter @rocketflare/cli build` bundles `src/cli.ts` into `dist/cli.js` with **esbuild** (shebang
kept; `chalk`, `commander`, `open`, `zod` stay external). Why not plain `tsc`: `@rocketflare/shared` is
consumed as TypeScript source (`exports` → `./src/*.ts`, extensionless relative imports), which Node
cannot load from `tsc` output at runtime — bundling inlines the contracts. `tsx src/cli.ts` (`pnpm
cli …`) needs no build. Run `node apps/cli/dist/cli.js --help` to check the bundle.

## Tests

`pnpm --filter @rocketflare/cli test` — vitest, Node environment, no server needed: `config.test.ts`
(temp dir, permissions, precedence), `api.test.ts` (mocked `fetch`: envelope → `CliApiError`, schema
validation), `login.test.ts` (real loopback server + simulated browser redirect, key redaction),
`commands.test.ts` (tables and `--json`).
