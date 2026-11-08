#!/usr/bin/env node
/**
 * What `.rocketflare.json`'s `defaultPlugins` says a fresh clone installs — one reader, for the two
 * workflows that each used to inline their own (D31, decisions 2 and 5). `--ci` adds the kit's
 * CI-only canaries from `.github/ci-plugins.json` (analytics: opt-in for a clone, still installed
 * on every kit pull request), and `kit:release` checks the same union.
 *
 *   node scripts/default-plugins.mjs [--ci]                  one human line; exit 1 on a malformed entry
 *   node scripts/default-plugins.mjs [--ci] --tsv            id \t repo \t ref \t subdir, one per line
 *   node scripts/default-plugins.mjs [--ci] --github-output  append `count=` and `ids=` to $GITHUB_OUTPUT
 *
 * The kit's workflows carried a `node --input-type=module -e "…"` block apiece doing this, and
 * they had already drifted in what they printed and what they refused. A shell heredoc is also the
 * one place the kit's own rules cannot reach: nothing lints it, nothing types it, and no test can
 * run it — so the validation moved into `defaultPluginEntryProblems` and kit.yml calls this.
 *
 * `readManifest()` rather than a literal filename, because the provenance file keeps the KIT's name
 * in a renamed copy while a literal here would be rewritten with everything else.
 *
 * Exit 0 ok · 1 a malformed entry · 2 usage.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readManifest } from './lib/manifest.mjs'
import { defaultPluginEntries, defaultPluginEntryProblems } from './lib/upgrade-lib.mjs'

export const USAGE = 'usage: node scripts/default-plugins.mjs [--ci] [--tsv | --github-output]'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CI_PLUGINS_FILE = '.github/ci-plugins.json'

/** The `plugins` list of `.github/ci-plugins.json` under `root`; `[]` when the file is absent. */
export function readCiPlugins(root = REPO_ROOT) {
  const file = path.join(root, CI_PLUGINS_FILE)
  if (!existsSync(file)) return []
  return JSON.parse(readFileSync(file, 'utf8')).plugins ?? []
}

/**
 * `defaultPlugins` plus the CI-only entries, normalised. An id in both is installed once, as the
 * default pins it — a clone and CI must not disagree about which version of a default they prove.
 */
export function ciPluginEntries(manifest, ciPlugins) {
  const defaults = defaultPluginEntries(manifest)
  const ids = new Set(defaults.map(e => e.id))
  const extra = defaultPluginEntries({ defaultPlugins: ciPlugins }).filter(e => !ids.has(e.id))
  return [...defaults, ...extra]
}

function main(argv) {
  let mode = 'human'
  let ci = false
  for (const arg of argv) {
    if (arg === '--ci') ci = true
    else if (arg === '--tsv') mode = 'tsv'
    else if (arg === '--github-output') mode = 'github-output'
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`)
      return 0
    } else {
      process.stderr.write(`error: unknown option '${arg}'\n\n${USAGE}\n`)
      return 2
    }
  }

  const { manifest } = readManifest()
  const entries = ci ? ciPluginEntries(manifest, readCiPlugins()) : defaultPluginEntries(manifest)
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
    ci
      ? `${entries.length} plugin(s) for CI (defaultPlugins + ${CI_PLUGINS_FILE}): ${ids || 'none'}\n`
      : entries.length === 0
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
