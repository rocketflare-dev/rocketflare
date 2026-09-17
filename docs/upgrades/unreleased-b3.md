## What changed

**Provisioning learns a plugin's platform declarations (D31, Decision 12).** A plugin ships no
wrangler toml — the two files are the host's, always — so its `plugin.json` declares what the
Cloudflare account has to provide, and `pnpm provision cloudflare <env>` now applies it instead of
a human editing both files by hand.

- **New: `apps/web/scripts/provision/plugin-resources.ts`** — the one owner of the naming rule and
  the one validator of the four platform declarations. Resources are
  `<app>-<id>-<name>[-staging]`, and `<APP>_<ID>_<NAME>[_STAGING]` for a KV namespace (mirroring the
  kit's own `<APP>_RATE_LIMIT[_STAGING]`); the `binding` name is identical in both environments.
  Supported `type`s are `kv`, `queue`, `r2`. Anything else — `d1`, `vectorize`,
  `analytics_engine`, `hyperdrive` — is a **loud refusal naming the type**, never a silent skip: a
  binding quietly not created is a Worker that deploys and then 503s on its first request.
  `hyperdrive` is refused deliberately — the host owns the one database.
- **`plugin.json` gains a documented shape for four fields** that were declared but unread:

  ```json
  "bindings":    [{ "type": "kv", "binding": "APPROVALS_CACHE", "name": "cache" },
                  { "type": "queue", "binding": "APPROVALS_QUEUE", "name": "jobs", "consumer": true },
                  { "type": "r2", "binding": "APPROVALS_FILES", "name": "files" }],
  "crons":       ["30 * * * *"],
  "apiPrefixes": ["/approvals-hook"],
  "vars":        [{ "key": "APPROVALS_MAX_ITEMS", "example": "50" },
                  { "key": "APPROVALS_WEBHOOK_SECRET", "example": "", "secret": true }]
  ```

  `secret` is new and defaults to false: a non-secret var is a `[vars]` key in both tomls, a secret
  one is a Worker secret offered by `pnpm provision secrets <env>`.
- **`cf-provision.sh` takes a resource list** rather than its fixed four. The kit's Hyperdrive, KV,
  Queue and R2 are the default list and its CLI is unchanged; `PLUGIN_RESOURCES` (a JSON array of
  `{ type, name, binding }`, in the ENVIRONMENT — nothing in it is secret and nothing is left on
  disk) appends to it. The connection-string redaction rule is untouched.
- **`patch-toml.ts` gains four byte-preserving, idempotent ops**: insert-or-update a binding block
  (`[[kv_namespaces]]` / `[[queues.producers]]` + `[[queues.consumers]]` / `[[r2_buckets]]`, placed
  after the last block of the same kind, or appended at the end of the file when there is none),
  append a cron, append a `[vars]` key (after the last assignment in the table, and never rewriting
  an existing key's value), and append a `run_worker_first` prefix as both `p` and `p/*`. A
  DIFFERENT existing id or name for the same `binding` is refused unless `--force`.
- **`pnpm provision cloudflare <env>`** writes the declarations into **both** tomls first (binding
  blocks with a `<PLACEHOLDER>` KV id, crons, `[vars]` keys, `run_worker_first` prefixes), then
  creates that environment's resources and patches its ids. Both files, because the ordinary parity
  test compares those across the pair on every `pnpm test`; the other environment's placeholder is
  refused by `REQUIRE_PROVISIONED=1` until it is provisioned too — exactly how `<HYPERDRIVE_ID>`
  already behaves.
- **`wrangler-parity.test.ts`** applies the same rules to plugin resources through the pure
  `pluginParityIssues()`, exercised against a FIXTURE plugin and fixture tomls as well as against
  what this checkout has installed — with `example-feature` declaring nothing, an installed-only
  assertion would pass because there is nothing to check.

## How to apply

1. Take the four changed provisioning files (`apps/web/scripts/provision.ts`,
   `apps/web/scripts/provision/patch-toml.ts`, the new
   `apps/web/scripts/provision/plugin-resources.ts`, `apps/web/scripts/cf-provision.sh`) and the two
   test files. They are kit core; a copy with no plugins installed behaves exactly as before.
2. The comment near the bindings in both `wrangler*.toml` is cosmetic — take it or leave it.
3. If you have a plugin installed that needs a KV namespace, queue or bucket, add its `bindings[]`,
   `crons[]`, `apiPrefixes[]` and `vars[]` to its `plugin.json` in the shape above and run
   `pnpm provision cloudflare staging` then `pnpm provision cloudflare production`, then
   `pnpm types` and commit `apps/web/worker-configuration.d.ts`.

## Conflicts to expect

- `apps/web/scripts/provision/patch-toml.ts`: `patchBindingId` was renamed `patchBindingKey` and
  takes the key (`id` / `queue` / `bucket_name`) as an argument; its intervening-line pattern is now
  `[^\n]+` rather than `[^\n]*`, so a match can no longer run past a blank line into the next block.
  If you extended that file, re-apply on top of the new signature.
- `apps/web/scripts/cf-provision.sh`: the four inline creation blocks became `ensure_hyperdrive`,
  `ensure_kv`, `ensure_queue` and `ensure_r2` functions driven by one loop over the resource list.
  Any local edit inside those blocks moves into the matching function.
- `apps/web/tests/config/wrangler-parity.test.ts` gains imports from `../../scripts/provision/*`.
  A copy that rewrote the parity test will reject that hunk; the new `describe` is self-contained
  and can be appended by hand.

## Verify

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build      # green
pnpm web exec vitest run --project config tests/config/plugin-resources.test.ts   # 19 passing
bash apps/web/scripts/cf-provision.sh --help                # usage line mentions PLUGIN_RESOURCES
```

With a plugin installed that declares a KV binding: `pnpm provision cloudflare staging` leaves a
`[[kv_namespaces]] binding = "<ITS_BINDING>"` block in **both** tomls, a real id in the staging file
and `<KV_<ID>_<NAME>_ID>` in production, `pnpm test` green, and
`REQUIRE_PROVISIONED=1 pnpm web test:config` failing on that placeholder until
`pnpm provision cloudflare production` runs.
