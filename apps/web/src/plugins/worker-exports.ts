/**
 * The plugin WORKER barrel (D31) — ONE `export *` per installed plugin, written by
 * `pnpm plugin add|remove`, never by hand:
 *
 *     export * from './approvals/worker-exports'
 *
 * It is re-exported by one permanent line in `src/worker.ts`, which is the Worker's entry module
 * and therefore the only place a Durable Object or Workflow class can be reached from: Cloudflare
 * binds `class_name` against the named exports of the entry script, and nothing else.
 *
 * **This barrel is to `worker.ts` what `schema.ts` is to `db/schema/index.ts`**, and for the same
 * reason. Before it, a plugin shipping a class declared `workerExports` in its manifest and the
 * install plan PRINTED "export { ApprovalsHub } from its plugin in apps/web/src/worker.ts". A
 * printed instruction is not a mechanism: an unattended install (`plugin-ci.yml` applies nothing it
 * reads) left a tree that deployed without the class and answered every request that reached it
 * with a binding error — the same failure `coreEdits` was introduced to remove, one file along.
 * `coreEdits` is not the fix either: using it here would have every class-shipping plugin mutating
 * `worker.ts`, which is precisely what a barrel exists to prevent.
 *
 * A plugin's half is `src/plugins/<id>/worker-exports.ts`, a file whose only job is to re-export
 * its classes; its PRESENCE is what makes `plugin add` write the line, exactly as every other
 * barrel decides. `plugin check` then asserts both directions, plus that each name the manifest
 * declares in `workerExports` really is exported there — a class in the barrel and not in the
 * manifest is invisible to provisioning, and the reverse is a binding pointed at nothing.
 *
 * **The `[[durable_objects.bindings]]`, `[[workflows]]` and `[[migrations]]` blocks are still the
 * HOST's**, written into BOTH tomls by `pnpm provision cloudflare <env>` from the same
 * `plugin.json` (D31, decision 12). A plugin edits no toml, here as everywhere. DO migration tags
 * are append-only and host-owned for the reason SQL migrations are: they are the record of what
 * this Worker has already told Cloudflare, and renumbering one loses a namespace.
 */
export {}
