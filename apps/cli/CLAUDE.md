# apps/cli — @gmgo/cli

CLI for the kit server (D26). commander + chalk + open + zod; `tsx` in dev, **esbuild** bundle to
`dist/cli.js` (bundles `@gmgo/shared` — Node can't load its `.ts` exports from `tsc` output).

```bash
pnpm cli <cmd>                        # from root: tsx src/cli.ts
pnpm --filter @gmgo/cli typecheck · test · build   # vitest node env, no server needed
```

## Layout

- `src/cli.ts` — commander wiring + the ONE error → exit-code mapper (`0 ok · 1 · 2 not logged in · 3 forbidden`)
- `src/context.ts` — `createContext({ server, json })` → `{ store, config, log, out, fetch, open }`; `requireClient` / `publicClient`
- `src/config.ts` — `~/.gmgo/config.json` (0700/0600), `ENV_PREFIX`, `DEFAULT_SERVER_URL`, `redactKey`
- `src/api.ts` — `createApiClient` → `request/get/post/del`, envelope → `CliApiError { status, code, body }`
- `src/auth.ts` — loopback `127.0.0.1:8765–8770/callback`, `/auth/cli?redirect_uri=`, 5-min timeout, `/api/me`
- `src/commands/*.ts` — thin `run<X>(ctx, opts)`; `src/utils/{brand,logger,output}.ts`

## Rules

- Contracts from `@gmgo/shared/<module>` subpaths only (the barrel drags everything into the bundle)
- Data → stdout via `ctx.out.data(raw, human)`; status/errors → stderr via `ctx.log`; `--json` prints the raw body
- Never print the API key in full — `redactKey`; never `process.exit` in a command, throw `CliError`
- `open`/`fetch`/config dir are injected (`ContextOptions`, `GMGO_CONFIG_DIR`) — tests use them, so keep them injectable
- Header comment per file referencing D26; Biome style; `import type`
