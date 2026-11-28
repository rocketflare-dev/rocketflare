/**
 * `pnpm web tool:egress` — call every unit's `tools(ctx)` with the stub context and print, as ONE
 * JSON document on stdout, each tool's `egress` / `readsContent` and every unit that could not be
 * read (`src/api/services/agents/tools/egress.ts`). `pnpm plugin check` runs this and turns each
 * tool without `egress` into a warning; it never fails on one.
 *
 * Everything else the builders log goes to stderr, so stdout stays the one document. Exit 0
 * whatever it finds (the warnings are the caller's to raise); 1 only if the check itself crashed.
 */
for (const level of ['log', 'info', 'warn', 'debug'] as const) {
  console[level] = (...args: unknown[]) => console.error(...args)
}

try {
  const { installedToolUnits, readToolEgress } = await import(
    '../src/api/services/agents/tools/egress'
  )
  const report = await readToolEgress(installedToolUnits())
  process.stdout.write(`${JSON.stringify(report)}\n`)
} catch (err) {
  console.error(err)
  process.exitCode = 1
}

// A module, so the top-level await above is allowed.
export {}
