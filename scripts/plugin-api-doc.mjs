#!/usr/bin/env node
/**
 * Generate the kit's plugin surface from the declared entries (D31): `docs/plugin-surface.json`
 * and the `## Surface ledger` block of `docs/plugin-api.md`.
 *
 *     node scripts/plugin-api-doc.mjs            write both files
 *     node scripts/plugin-api-doc.mjs --check    exit 2 if either is out of date, write nothing
 *
 * **What it records.** One row per member the kit provides — its entry, its kind and its name —
 * plus the expanded members of the context family and the slot types (`RequestCtx.guard`), the
 * moved-symbol map, and the aliases a declared entry is also spelled with. It is what makes
 * compatibility an OBSERVATION rather than a prediction: a plugin's use is derived from its own
 * imports and the answer is the set difference `uses \ surface` (`scripts/lib/surface.mjs`).
 *
 * **No signatures, and no type checker.** The names come from a parser (`oxc-parser`, through
 * `scripts/lib/module-exports.mjs`), which follows the barrels' re-exports to each declaration's
 * syntax. A moved-symbol suggestion needs only a name; an agent wanting a signature reads the entry
 * barrel itself. `apps/web/tests/kit-only/plugin-surface.test.ts` proves the parser lists exactly
 * what the type checker did.
 *
 * **Two files, one surface.** `plugin-surface.json` is what `readLedger` reads first. The Markdown
 * ledger is still emitted because plugin repositories vendor an older `surface.mjs` that reads only
 * it; it goes once they read the JSON (#182). The "what you want to do" index that used to open the
 * document is hand-written in `.claude/skills/rf-plugin/reference.md` now, and checked there.
 *
 * **A diff failure in CI means a file is stale, not that the gate is broken.** Run this script and
 * commit what it writes. It is the KIT's check (`.github/workflows/kit.yml`), not a copy's: the
 * surface is the kit's published plugin API, which protects plugins in other repositories.
 *
 * Exit codes: 0 ok · 1 error · 2 out of date (`--check`).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDeclaredSurface, renderSurfaceJson, SURFACE_JSON } from './lib/plugin-surface.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = path.join(REPO_ROOT, 'docs/plugin-api.md')
const JSON_PATH = path.join(REPO_ROOT, SURFACE_JSON)

// ---- rendering ---------------------------------------------------------------------------------

function renderHeader() {
  return `# The plugin API

**Generated. Do not edit.** \`node scripts/plugin-api-doc.mjs\` writes this file and
\`docs/plugin-surface.json\` from the source of the declared entries, and the kit's CI
(\`.github/workflows/kit.yml\`) regenerates both and diffs them. **A diff failure means a file is
stale. Run the script and commit what it writes.**

This is the whole of what a plugin may import from the host. The rule the entries make true is one
sentence: **a plugin imports only from declared entries, and receives everything else as injected
context** (\`apps/web/tests/helpers/plugins.ts\` enforces it, and every diagnostic it prints carries
the replacement import). Anything not listed here is a kit internal: reaching for it is what makes a
plugin's own version number meaningless, because the plugin is then pinned to something nobody
promised to keep.

- **What to import for a job** — "handle a request", "enqueue a job", "prove tenant isolation" —
  is the index in \`.claude/skills/rf-plugin/reference.md\` ("What you want to do").
- **A member's signature** is in the entry barrel itself; each entry below names its file.
- **The machine-readable surface** is \`docs/plugin-surface.json\`. The ledger at the end of this
  file carries the same names, for plugin tooling that has not moved to the JSON yet.
`
}

function renderEntries(entries) {
  const rows = entries.map(e => `| \`${e.import}\` | \`${e.file}\` | ${e.role} |`)
  return `## The entries

| Import | File | For |
|---|---|---|
${rows.join('\n')}
`
}

/**
 * What a plugin reaches OUTSIDE the ledgered entries: its own seeded host files, and the manifest
 * slots that write beyond its four roots. Not ledgered — none of them is a kit symbol a release
 * could drop — but part of the contract, so stated here beside the entries.
 */
function renderOutsideRoots() {
  return `## Your own host files, and what the manifest writes outside your roots

- **\`@/host/<id>/*\`** — \`apps/web/src/host/<id>/\`, code the plugin seeded through \`hostFiles\`
  and the developer owns since (a generated content module, say). A plugin may import its OWN
  id's directory and no other (\`tests/helpers/plugins.ts\`); it resolves through the existing
  \`@/*\` alias, so no tsconfig, Vite or wrangler change. Not ledgered: the kit provides none of it.
- **\`skills\`** — \`skills/<dir>/\` → \`.claude/skills/<dir>/\`, \`<dir>\` being \`<id>\` or \`<id>-*\`.
  Replaced on upgrade, deleted on remove.
- **\`claudeHooks\`** — \`{ "<Event>": [{ "command", "matcher"?, "timeout"? }] }\`, merged into
  \`.claude/settings.json\`. A command is only \`node "$CLAUDE_PROJECT_DIR/.claude/skills/<dir>/<script>"\`
  (plus plain flags) over a script one of its declared skills ships; the skill directory is how the
  plugin's entries are found again. Replaced on upgrade, removed exactly on remove.
- **\`hostFiles\`** — \`[{ "path", "from" }]\`, a file or a directory seeded into \`docs/<id>/\`,
  \`apps/web/public/<id>/\` or \`apps/web/src/host/<id>/\` only where absent. Never touched by
  upgrade, left in place by remove.
- **\`coreEdits\`** and **\`appOwned\`** — anchored lines in a core file, and paths inside the
  plugin's own roots that the developer owns (\`apps/web/src/plugins/CLAUDE.md\`).
`
}

/**
 * `entry :: kind :: name :: -`, one line per member. The fourth field was the signature; it is
 * kept as `-` because the vendored readers skip a row with fewer than four fields.
 */
function renderLedger(surface) {
  const lines = surface.members.map(m => `${m.entry} :: ${m.kind} :: ${m.name} :: -`)
  return `## Surface ledger

The same members as \`docs/plugin-surface.json\`, one line each, \`entry :: kind :: name :: -\`.
Kept for plugin tooling that reads this file rather than the JSON; it goes once that tooling has
moved (#182). The fourth field was a signature and is always \`-\` now.

\`\`\`text
${lines.join('\n')}
\`\`\`
`
}

function renderMarkdown(surface) {
  const parts = [
    renderHeader(),
    renderEntries(surface.entries),
    renderOutsideRoots(),
    renderLedger(surface),
  ]
  return `${parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

// ---- main --------------------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes('--check')
  const surface = readDeclaredSurface(REPO_ROOT)
  const outputs = [
    [DOC_PATH, renderMarkdown(surface)],
    [JSON_PATH, renderSurfaceJson(surface)],
  ]
  const stale = outputs.filter(
    ([file, text]) => !existsSync(file) || readFileSync(file, 'utf8') !== text
  )
  const count = surface.members.length
  const names = stale.map(([file]) => path.relative(REPO_ROOT, file)).join(' and ')

  if (check) {
    if (stale.length === 0) {
      console.log(`✔ the plugin surface is up to date (${count} members)`)
      return 0
    }
    console.error(`✖ ${names} out of date — run \`node scripts/plugin-api-doc.mjs\``)
    return 2
  }
  for (const [file, text] of stale) writeFileSync(file, text)
  console.log(
    stale.length > 0
      ? `✔ wrote ${names} (${count} members)`
      : `✔ the plugin surface is up to date (${count} members)`
  )
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`✖ ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
