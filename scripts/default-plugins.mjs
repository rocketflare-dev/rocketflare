#!/usr/bin/env node
/**
 * What `.rocketflare.json`'s `defaultPlugins` says a fresh clone installs — one reader, for the two
 * workflows that each used to inline their own (D31, decisions 2 and 5).
 *
 *   node scripts/default-plugins.mjs                  one human line; exit 1 on a malformed entry
 *   node scripts/default-plugins.mjs --tsv            id \t repo \t ref \t subdir, one per line
 *   node scripts/default-plugins.mjs --github-output  append `count=` and `ids=` to $GITHUB_OUTPUT
 *
 * `ci.yml` and `gate.yml` carried a `node --input-type=module -e "…"` block apiece doing this, and
 * they had already drifted in what they printed and what they refused. A shell heredoc is also the
 * one place the kit's own rules cannot reach: nothing lints it, nothing types it, and no test can
 * run it — so the validation moved into `defaultPluginEntryProblems` and both workflows call this.
 *
 * `readManifest()` rather than a literal filename, because the provenance file keeps the KIT's name
 * in a renamed copy while a literal here would be rewritten with everything else.
 *
 * Exit 0 ok · 1 a malformed entry · 2 usage.
 */
import { appendFileSync } from 'node:fs'
import { readManifest } from './lib/manifest.mjs'
import { defaultPluginEntries, defaultPluginEntryProblems } from './lib/upgrade-lib.mjs'

export const USAGE = 'usage: node scripts/default-plugins.mjs [--tsv | --github-output]'

function main(argv) {
  let mode = 'human'
  for (const arg of argv) {
    if (arg === '--tsv') mode = 'tsv'
    else if (arg === '--github-output') mode = 'github-output'
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`)
      return 0
    } else {
      process.stderr.write(`error: unknown option '${arg}'\n\n${USAGE}\n`)
      return 2
    }
  }

  const entries = defaultPluginEntries(readManifest().manifest)
  const problems = defaultPluginEntryProblems(entries)
  for (const problem of problems) {
    // `::error::` is what puts it in the run summary rather than only in a fold nobody opens.
    process.stderr.write(`::error::${problem}\n`)
  }
  if (problems.length > 0) return 1

  if (mode === 'tsv') {
    // Tab-separated because a repository URL contains `/` and `:` and a ref may contain `.`; the
    // consuming `while IFS=$'\t' read` loop then needs no quoting rules of its own.
    for (const e of entries) {
      process.stdout.write([e.id, e.repo, e.ref ?? '', e.subdir ?? ''].join('\t') + '\n')
    }
    return 0
  }

  const ids = entries.map(e => e.id).join(', ')
  process.stdout.write(
    entries.length === 0
      ? 'No default plugins — a fresh clone of this kit installs nothing beyond the kit.\n'
      : `${entries.length} default plugin(s): ${ids}\n`
  )
  if (mode === 'github-output' && process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `count=${entries.length}\nids=${ids}\n`)
  }
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
